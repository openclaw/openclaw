/**
 * Types for the Credential Firewall — domain-pinned credential injection
 * where the LLM agent never sees the actual credential value.
 *
 * See: https://github.com/openclaw/openclaw/issues/18245
 */

export interface CredentialEntry {
  slot: string;
  source: string;
  pinnedDomains: string[];
  allowedSelectors?: string[];
  field?: string;
  expiresAt?: string;
  label?: string;
}

export interface CredentialUseRecord {
  slot: string;
  domain: string;
  selector: string;
  timestamp: string;
  allowed: boolean;
  reason?: string;
}

export interface CredentialStoreConfig {
  credentials?: CredentialEntry[];
}
