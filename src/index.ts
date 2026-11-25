import type { Context, MiddlewareHandler, Next } from 'hono'

export interface ChainRule {
  name: string
  pattern: RegExp
  requiresMemo: boolean
  memoName: string
  memoPattern?: RegExp
}

export const CHAIN_RULES: Record<string, ChainRule> = {
  EVM:  { name: 'Ethereum / Arbitrum / Base / Optimism / Polygon / BNB (EVM)', pattern: /^0x[a-fA-F0-9]{40}$/, requiresMemo: false, memoName: 'None' },
  BTC:  { name: 'Bitcoin (Legacy / SegWit / Taproot Bech32m)', pattern: /^(1[a-km-zA-HJ-NP-Z1-9]{25,34}|3[a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{25,87})$/, requiresMemo: false, memoName: 'None' },
  SOL:  { name: 'Solana (Ed25519 Base58)', pattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, requiresMemo: false, memoName: 'SPL Memo (Optional)' },
  XRP:  { name: 'XRP Ledger (XRPL)', pattern: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/, requiresMemo: true, memoName: 'Destination Tag (32-bit uint)', memoPattern: /^[0-9]{1,10}$/ },
  XLM:  { name: 'Stellar Lumens (StrKey)', pattern: /^G[A-Z2-7]{55}$/, requiresMemo: true, memoName: 'Stellar Memo (up to 28 bytes)', memoPattern: /^.{1,28}$/ },
  ATOM: { name: 'Cosmos Hub (Bech32)', pattern: /^cosmos1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$/, requiresMemo: true, memoName: 'Cosmos Memo', memoPattern: /^.{1,256}$/ },
  TON:  { name: 'The Open Network (TON)', pattern: /^((EQ|UQ)[A-Za-z0-9_-]{46}|(0|-1):[a-fA-F0-9]{64})$/, requiresMemo: true, memoName: 'TON Comment / Memo Tag', memoPattern: /^.{1,120}$/ },
  TRX:  { name: 'TRON (TVM Base58Check)', pattern: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, requiresMemo: false, memoName: 'None' },
  SUI:  { name: 'Sui Network', pattern: /^0x[a-fA-F0-9]{64}$/, requiresMemo: false, memoName: 'None' },
  APT:  { name: 'Aptos Network', pattern: /^0x[a-fA-F0-9]{1,64}$/, requiresMemo: false, memoName: 'None' },
  HBAR: { name: 'Hedera Hashgraph', pattern: /^0\.0\.[1-9][0-9]{0,9}$/, requiresMemo: true, memoName: 'Hedera Memo (up to 100 bytes)', memoPattern: /^.{1,100}$/ },
  EOS:  { name: 'EOSIO / Vaulta', pattern: /^[a-z1-5.]{1,12}$/, requiresMemo: true, memoName: 'EOS Memo', memoPattern: /^.{1,256}$/ }
}

export interface ValidationResult {
  valid: boolean
  code: 'VALID_VERIFIED' | 'UNSUPPORTED_CHAIN' | 'INVALID_ADDRESS_SYNTAX' | 'MISSING_MANDATORY_MEMO' | 'INVALID_MEMO_FORMAT' | 'ADDRESS_POISONING_ALERT'
  chain: string
  message: string
}

export function detectAddressPoisoning(candidate: string, trusted: string): boolean {
  const a = (candidate || '').trim()
  const b = (trusted || '').trim()
  if (!a || !b || a.toLowerCase() === b.toLowerCase() || a.length < 12 || b.length < 12) return false
  return a.slice(0, 5).toLowerCase() === b.slice(0, 5).toLowerCase() && a.slice(-4).toLowerCase() === b.slice(-4).toLowerCase()
}

export function validateCryptoAddress(chain: string, address: string, memo = '', trustedAddress = ''): ValidationResult {
  const code = (chain || '').trim().toUpperCase()
  const rule = CHAIN_RULES[code]
  if (!rule) {
    return { valid: false, code: 'UNSUPPORTED_CHAIN', chain: code, message: `Unsupported blockchain ticker: ${code}` }
  }
  const cleanAddr = (address || '').trim()
  const cleanMemo = (memo || '').trim()
  if (!cleanAddr || !rule.pattern.test(cleanAddr)) {
    return { valid: false, code: 'INVALID_ADDRESS_SYNTAX', chain: code, message: `Invalid ${rule.name} wallet address format.` }
  }
  if (rule.requiresMemo) {
    if (!cleanMemo) {
      return { valid: false, code: 'MISSING_MANDATORY_MEMO', chain: code, message: `${code} custodial transfers require a mandatory ${rule.memoName}.` }
    }
    if (rule.memoPattern && !rule.memoPattern.test(cleanMemo)) {
      return { valid: false, code: 'INVALID_MEMO_FORMAT', chain: code, message: `Invalid ${rule.memoName} format for ${code}.` }
    }
  }
  if (trustedAddress && detectAddressPoisoning(cleanAddr, trustedAddress)) {
    return {
      valid: false,
      code: 'ADDRESS_POISONING_ALERT',
      chain: code,
      message: 'CRITICAL ALERT: Candidate address matches prefix & suffix of trusted reference address while differing in middle bytes.'
    }
  }
  return { valid: true, code: 'VALID_VERIFIED', chain: code, message: `Verified valid ${rule.name} address and routing configuration.` }
}

export interface AddressValidatorOptions {
  chainField?: string
  addressField?: string
  memoField?: string
  trustedAddressField?: string
}

export const addressValidator = (options: AddressValidatorOptions = {}): MiddlewareHandler => {
  const chainKey = options.chainField ?? 'chain'
  const addrKey = options.addressField ?? 'address'
  const memoKey = options.memoField ?? 'memo'
  const trustedKey = options.trustedAddressField ?? 'trustedAddress'

  return async (c: Context, next: Next) => {
    let payload: Record<string, unknown> = {}
    if (c.req.method === 'GET') {
      payload = c.req.query()
    } else {
      try {
        payload = await c.req.json()
      } catch {
        payload = c.req.query()
      }
    }
    const result = validateCryptoAddress(
      String(payload[chainKey] ?? ''),
      String(payload[addrKey] ?? ''),
      String(payload[memoKey] ?? ''),
      String(payload[trustedKey] ?? '')
    )
    if (!result.valid) {
      return c.json(result, 400)
    }
    c.set('cryptoAddressValidation', result)
    await next()
  }
}
