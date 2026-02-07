/**
 * Type definitions for the secrets configuration block.
 */

/** Supported secrets provider identifiers. */
export type SecretsProviderType =
  | "gcp"
  | "aws"
  | "env"
  | "keyring"
  | "1password"
  | "doppler"
  | "bitwarden"
  | "vault";

/** Configuration for secrets resolution in openclaw.json. */
export interface SecretsConfig {
  /** The secrets provider to use for resolving `$secret{...}` references. */
  provider?: SecretsProviderType;

  /** GCP Secret Manager options. */
  gcp?: {
    /** GCP project ID (required — Secret Manager doesn't support automatic project discovery). */
    project: string;
  };

  /** AWS Secrets Manager options. */
  aws?: {
    /** AWS region. Defaults to the AWS SDK default region. */
    region?: string;
  };

  /** Doppler options. */
  doppler?: {
    /** Doppler project name. */
    project?: string;
    /** Doppler config/environment (e.g. "dev", "staging", "prod"). */
    config?: string;
  };

  /** HashiCorp Vault options. */
  vault?: {
    /** Vault server address (e.g. "https://vault.example.com:8200"). */
    address?: string;
    /** Vault namespace (enterprise feature). */
    namespace?: string;
    /** Secret engine mount path (default: "secret"). */
    mountPath?: string;
  };

  /** OS Keyring / macOS Keychain options. */
  keyring?: {
    /** Path to the keychain file (macOS only). Defaults to ~/Library/Keychains/openclaw.keychain-db. */
    keychainPath?: string;
    /** Password to unlock the keychain. Defaults to empty string. */
    keychainPassword?: string;
    /** Account name for keychain items. Defaults to "openclaw". */
    account?: string;
  };

  /**
   * Optional mapping of secret names to config paths.
   * Reserved for future use (e.g. auto-mapping secrets to config locations).
   */
  mapping?: Record<string, string>;
}
