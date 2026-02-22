/**
 * Types for the Credential Firewall — domain-pinned credential injection
 * where the LLM agent never sees the actual credential value.
 *
 * See: https://github.com/openclaw/openclaw/issues/18245
 */

export interface CredentialEntry {
  slot: string;
  /** Primary credential source (typically the password). Any ${provider:...} syntax. */
  source: string;
  pinnedDomains: string[];
  allowedSelectors?: string[];
  /** Optional username source — resolved separately from the primary source. */
  usernameSource?: string;
  /** TOTP secret source — used to generate time-based codes when field="totp". */
  totpSource?: string;
  /** Sub-field to extract from the secret (e.g., "password" for Bitwarden items). */
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
