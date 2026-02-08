import path from "node:path";

/**
 * AgentShield Trust Enforcement Configuration
 *
 * Reads configuration from environment variables with safe defaults
 * (all strict requirements default off — non-breaking).
 *
 * Env vars:
 * - AGENTSHIELD_TRUST_ROOT          — path to trust root directory
 * - AGENTSHIELD_REVOCATIONS_FILE    — path to revocations.json (defaults to <trust_root>/revocations.json)
 * - AGENTSHIELD_REQUIRE_KEYRING     — 0|1 (default 0): fail when signing key not in publisher keyring
 * - AGENTSHIELD_REQUIRE_NOT_REVOKED — 0|1 (default 0): fail when publisher/artifact is revoked
 * - AGENTSHIELD_KEYS_DIR            — directory for signer keys (defaults to <stateDir>/agentshield/keys)
 */

export type TrustEnforcementConfig = {
  /** Whether trust enforcement is enabled (true when trustRoot is set) */
  enabled: boolean;
  /** Path to the trust root directory */
  trustRoot: string | null;
  /** Path to the revocations file */
  revocationsFile: string | null;
  /** If true, block when signing key is not in publisher keyring */
  requireKeyring: boolean;
  /** If true, block when publisher or artifact is revoked */
  requireNotRevoked: boolean;
  /** Directory for signer keys */
  keysDir: string | null;
};

let cachedConfig: TrustEnforcementConfig | null = null;

function envBool(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (val === undefined || val === "") {
    return defaultValue;
  }
  return val === "1" || val === "true";
}

/**
 * Build the trust enforcement config from current environment.
 * Result is cached — call clearTrustEnforcementConfigCache() in tests.
 */
export function getTrustEnforcementConfig(): TrustEnforcementConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const trustRoot = process.env.AGENTSHIELD_TRUST_ROOT || null;

  // Default revocations file: <trust_root>/revocations.json
  const revocationsFile =
    process.env.AGENTSHIELD_REVOCATIONS_FILE ||
    (trustRoot ? path.join(trustRoot, "revocations.json") : null);

  const requireKeyring = envBool("AGENTSHIELD_REQUIRE_KEYRING", false);
  const requireNotRevoked = envBool("AGENTSHIELD_REQUIRE_NOT_REVOKED", false);

  const keysDir = process.env.AGENTSHIELD_KEYS_DIR || null;

  // Enabled whenever a trust root is configured
  const enabled = trustRoot !== null;

  cachedConfig = {
    enabled,
    trustRoot,
    revocationsFile,
    requireKeyring,
    requireNotRevoked,
    keysDir,
  };

  return cachedConfig;
}

/**
 * Clear the cached config (for testing).
 */
export function clearTrustEnforcementConfigCache(): void {
  cachedConfig = null;
}
