/**
 * Secrets management API - high-level interface for CLI and tools.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { auditLog } from "./audit-log.js";
import {
  checkGrant as checkGrantFile,
  listGrants as listGrantFiles,
  revokeGrant as revokeGrantFile,
  validateSecretName,
  writeGrant,
  type GrantInfo,
} from "./grants.js";
import { keychainGet, keychainSet } from "./keychain.js";
import {
  capTtl,
  getDefaultTtl,
  getRegistry,
  getSecretDef as getSecretDefFromRegistry,
  getTierConfig,
  type SecretDefinition,
  type SecretTier,
} from "./registry.js";
import { validateTotp } from "./totp.js";
import { createVaultBackend, type VaultBackend } from "./vault-backend.js";

// Re-export types for convenience
export type { SecretDefinition, SecretTier, GrantInfo };

// Re-export registry functions for tool/CLI use
export { getSecretDefFromRegistry as getSecretDef };

/**
 * Type alias for SecretDefinition (CLI expects SecretDef)
 */
export type SecretDef = SecretDefinition;

/**
 * Secret metadata (agent-blind mode) - returned instead of value.
 */
export interface SecretMetadata {
  name: string;
  type?: string;
  hint?: string;
  capabilities?: string[];
  ref: string; // "secret:<name>"
  tier: SecretTier;
  expiresAt?: number;
}

/**
 * Grant status with more detailed states.
 */
export type GrantStatus =
  | { status: "valid"; expiresAt: number; remaining: number }
  | { status: "expired"; expiredAt: number }
  | { status: "missing" };

/**
 * Grant result with expiry information.
 */
export interface GrantResult {
  name: string;
  expiresAt: number;
  ttlMinutes: number;
}

/**
 * TOTP setup result.
 */
export interface TotpSetupResult {
  secret: string;
  uri: string;
}

/**
 * Secret grant information for listing.
 */
export interface SecretGrant {
  name: string;
  expiresAt: number;
  remainingMinutes?: number;
}

const TOTP_SECRET_NAME = "_totp_secret";

/**
 * Lazy-initialized vault backend.
 */
let _vaultBackend: VaultBackend | null = null;

/**
 * Get vault backend instance (lazy-init from config).
 */
function getVaultBackend(): VaultBackend {
  if (!_vaultBackend) {
    // Default to keychain — config-based backend selection
    // happens at init time if needed
    _vaultBackend = createVaultBackend("keychain");
  }
  return _vaultBackend;
}

/**
 * Initialize vault backend from config. Call during startup.
 */
export function initVaultBackend(backendType?: string): void {
  _vaultBackend = createVaultBackend(backendType ?? "keychain");
}

/**
 * Get TOTP secret from keychain.
 */
async function getTotpSecret(): Promise<string> {
  const secret = await keychainGet(TOTP_SECRET_NAME);
  if (!secret) {
    throw new Error("TOTP not configured. Run 'openclaw secrets setup-totp' first.");
  }
  return secret;
}

/**
 * Validate TOTP code against stored secret.
 */
async function validateTotpCode(code: string): Promise<void> {
  const secret = await getTotpSecret();
  if (!validateTotp(secret, code)) {
    throw new Error("Invalid TOTP code");
  }
}

/**
 * Check grant status for a secret.
 * @param name Secret name
 * @returns Grant status
 */
export async function checkGrant(name: string): Promise<GrantStatus> {
  const info = await checkGrantFile(name);

  if (!info.valid) {
    return { status: "missing" };
  }

  if (!info.expiresAt) {
    return { status: "missing" };
  }

  const now = Date.now();
  const expiresAtMs = info.expiresAt * 1000;

  if (expiresAtMs <= now) {
    return { status: "expired", expiredAt: expiresAtMs };
  }

  return {
    status: "valid",
    expiresAt: expiresAtMs,
    remaining: expiresAtMs - now,
  };
}

/**
 * Retrieve a secret via the OS-level privileged broker (sirbam's bamwerks keychain).
 *
 * The secrets-broker runs as sirbam via sudoers and reads from sirbam's personal
 * bamwerks keychain — a keychain the openclaw process cannot access directly.
 * The secret value is returned only via stdout pipe and never persisted.
 *
 * This is the OS-level blind: even a fully compromised openclaw process cannot
 * exfiltrate these secrets without broker cooperation, because they do not exist
 * in any keychain the openclaw user can query.
 *
 * @param name Secret name (account name in bamwerks keychain)
 * @returns Secret value from sirbam's bamwerks keychain
 * @throws Error if broker unavailable or secret not found
 */
export function getSecretViaBroker(name: string): string {
  const BROKER = "/usr/local/libexec/openclaw/secrets-broker";
  try {
    const result = execFileSync("sudo", ["-u", "sirbam", BROKER, name], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const value = result.trim();
    if (!value) {
      throw new Error(`Broker returned empty value for '${name}'`);
    }
    return value;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`OS broker failed for '${name}': ${msg}`, { cause: err });
  }
}

/**
 * Get a secret value (checks tier and grant).
 *
 * ⚠️ SECURITY: This returns the raw secret value. In agent-blind modes
 * (balanced/strict), agents should use getSecretMetadata() instead.
 * The secrets tool enforces mode-based access. Do NOT expose this
 * function to agent code paths. CLI and credential broker only.
 *
 * @param name Secret name
 * @returns Secret value
 * @throws Error if secret not found, not registered, or grant missing
 */
export async function getSecret(name: string): Promise<string> {
  // Validate name
  validateSecretName(name);

  // Get tier — fall back to open if not registered (keychain-only secret)
  const secretDef = getSecretDefFromRegistry(name);
  const tier = secretDef?.tier ?? "open";

  // Check grant for non-open tier
  if (tier !== "open") {
    const grantStatus = await checkGrant(name);
    if (grantStatus.status !== "valid") {
      const tierConfig = getTierConfig(tier);
      // Audit log the denial before throwing
      await auditLog({
        event: "credential_denied",
        name,
        timestamp: Date.now(),
        details: { tier, grantStatus: grantStatus.status },
      }).catch(() => {
        // Never let audit log failure mask the real error
      });
      throw new Error(
        `No valid grant for '${name}' (tier: ${tier}, default TTL: ${tierConfig.defaultTtl}m)`,
      );
    }
  }

  // Retrieve from appropriate backend
  let value: string;
  if (secretDef?.agentBlind) {
    // OS-level blind: route through privileged broker (sirbam's bamwerks keychain)
    value = getSecretViaBroker(name);
  } else {
    const vault = getVaultBackend();
    const rawValue = await vault.get(name);
    if (rawValue == null) {
      throw new Error(`Secret '${name}' not found. Store it with: openclaw secrets set ${name}`);
    }
    value = rawValue;
  }

  // Audit log
  await auditLog({
    event: "credential_accessed",
    name,
    timestamp: Date.now(),
    details: { tier, backend: secretDef?.agentBlind ? "broker" : getVaultBackend().name },
  });

  return value;
}

/**
 * Get secret metadata without value (agent-blind mode).
 * @param name Secret name
 * @returns Metadata without value
 * @throws Error if secret not found, not registered, or grant missing
 */
export async function getSecretMetadata(name: string): Promise<SecretMetadata> {
  // Validate name
  validateSecretName(name);

  // Get secret definition from registry
  const secretDef = getSecretDefFromRegistry(name);
  if (!secretDef) {
    throw new Error(`Secret '${name}' not registered`);
  }

  // Check grant for non-open tier
  const tier = secretDef.tier;
  let expiresAt: number | undefined;

  if (tier !== "open") {
    const grantStatus = await checkGrant(name);
    if (grantStatus.status !== "valid") {
      const tierConfig = getTierConfig(tier);
      throw new Error(
        `No valid grant for '${name}' (tier: ${tier}, default TTL: ${tierConfig.defaultTtl}m)`,
      );
    }
    expiresAt = grantStatus.expiresAt;
  }

  // Audit log
  await auditLog({
    event: "metadata_accessed",
    name,
    timestamp: Date.now(),
    details: { tier, hasGrant: tier === "open" || expiresAt !== undefined },
  });

  return {
    name,
    type: secretDef.type,
    hint: secretDef.description,
    capabilities: secretDef.capabilities,
    ref: `secret:${name}`,
    tier,
    expiresAt,
  };
}

/**
 * Set a secret value and register it.
 * @param name Secret name
 * @param value Secret value
 * @param tier Access tier
 * @param description Optional description
 */
export async function setSecret(
  name: string,
  value: string,
  tier: SecretTier = "controlled",
  description?: string,
): Promise<void> {
  // Validate name
  validateSecretName(name);

  // Store in vault backend
  const vault = getVaultBackend();
  await vault.set(name, value);

  // Persist registry entry to openclaw.json
  try {
    const { loadConfig } = await import("../config/config.js");
    const { writeConfigFile } = await import("../config/io.js");
    const config = loadConfig();
    if (!config.secrets) {
      config.secrets = {};
    }
    if (!config.secrets.registry) {
      config.secrets.registry = [];
    }

    // Remove existing entry if present
    config.secrets.registry = config.secrets.registry.filter(
      (e: unknown) => (e as { name: string }).name !== name,
    );

    // Add new entry
    const entry: { name: string; tier: SecretTier; description?: string } = { name, tier };
    if (description) {
      entry.description = description;
    }
    config.secrets.registry.push(entry);

    await writeConfigFile(config);
  } catch (err) {
    const vault = getVaultBackend();
    console.warn(
      `Note: Secret stored in ${vault.name} but registry not persisted to config: ` +
        (err as Error).message,
    );
  }
}

/**
 * Grant time-limited access to a secret (validates TOTP).
 * @param name Secret name
 * @param totpCode 6-digit TOTP code
 * @param ttlMinutes Optional TTL in minutes (defaults to tier default)
 * @returns Grant result with expiry info
 * @throws Error if TOTP invalid or secret not registered
 */
export async function grantSecret(
  name: string,
  totpCode: string,
  ttlMinutes?: number,
): Promise<GrantResult> {
  // Validate name
  validateSecretName(name);

  // Validate TOTP
  await validateTotpCode(totpCode);

  // Get secret definition (may not exist for internal grants like _elevated_session)
  const secretDef = getSecretDefFromRegistry(name);

  // Determine TTL
  let ttl: number;
  if (secretDef) {
    ttl = ttlMinutes ?? secretDef.ttl ?? getDefaultTtl(secretDef.tier);
    ttl = capTtl(secretDef.tier, ttl, secretDef);
  } else {
    // Internal/unregistered grant — use provided TTL or default 30min
    ttl = ttlMinutes ?? 30;
  }

  // Write grant file
  await writeGrant(name, ttl);

  const expiresAt = Date.now() + ttl * 60 * 1000;

  // Audit log
  await auditLog({
    event: "grant_created",
    name,
    timestamp: Date.now(),
    details: {
      ttlMinutes: ttl,
      expiresAt,
      tier: secretDef?.tier,
    },
  });

  return {
    name,
    expiresAt,
    ttlMinutes: ttl,
  };
}

/**
 * Revoke a secret's grant.
 * @param name Secret name
 */
export async function revokeSecret(name: string): Promise<void> {
  validateSecretName(name);
  await revokeGrantFile(name);

  // Audit log
  await auditLog({
    event: "grant_revoked",
    name,
    timestamp: Date.now(),
  });
}

/**
 * Delete a secret from keychain and revoke any grant.
 * @param name Secret name
 */
export async function deleteSecret(name: string): Promise<void> {
  // Validate name
  validateSecretName(name);

  // Delete from vault backend
  const vault = getVaultBackend();
  await vault.delete(name);

  // Revoke any active grant
  await revokeGrantFile(name);

  // Remove from openclaw.json registry
  try {
    const { loadConfig } = await import("../config/config.js");
    const { writeConfigFile } = await import("../config/io.js");
    const config = loadConfig();
    if (config.secrets?.registry) {
      config.secrets.registry = config.secrets.registry.filter(
        (e: unknown) => (e as { name: string }).name !== name,
      );
      await writeConfigFile(config);
    }
  } catch (err) {
    console.warn(
      `Note: Secret deleted from ${vault.name} but registry not updated: ` + (err as Error).message,
    );
  }
}

/**
 * Secret definition enriched with grant status.
 */
export interface SecretWithGrant extends SecretDefinition {
  grant: {
    valid: boolean;
    expiresAt?: number;
    remainingMinutes?: number;
  };
}

/**
 * List all registered secrets with grant status.
 * @returns Array of secret definitions with grant information
 */
export async function listSecrets(): Promise<SecretWithGrant[]> {
  const registry = getRegistry();

  // Enrich each secret with grant status
  const enriched = await Promise.all(
    registry.map(async (secret) => {
      const grantInfo = await checkGrantFile(secret.name);
      return {
        ...secret,
        grant: {
          valid: grantInfo.valid,
          expiresAt: grantInfo.expiresAt,
          remainingMinutes: grantInfo.remainingMinutes,
        },
      };
    }),
  );

  return enriched;
}

/**
 * List all active grants.
 * @returns Array of grant information
 */
export async function listGrants(): Promise<SecretGrant[]> {
  const grants = await listGrantFiles();

  return grants
    .filter((g) => g.info.valid)
    .map((g) => ({
      name: g.name,
      expiresAt: (g.info.expiresAt ?? 0) * 1000,
      remainingMinutes: g.info.remainingMinutes,
    }));
}

/**
 * Setup TOTP authenticator.
 * Generates a random 20-byte base32-encoded secret and stores it in the keychain.
 * @returns TOTP setup information (secret and URI)
 */
export async function setupTotp(): Promise<TotpSetupResult> {
  // Generate random 160-bit (20-byte) secret and encode as base32
  const bytes = randomBytes(20);

  // Base32 encode (RFC 4648)
  const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const byte of bytes) {
    bits += byte.toString(2).padStart(8, "0");
  }

  let secret = "";
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, "0");
    const index = Number.parseInt(chunk, 2);
    secret += BASE32_CHARS[index];
  }

  // Store in keychain
  await keychainSet(TOTP_SECRET_NAME, secret);

  // Generate URI for QR code
  const uri = `otpauth://totp/OpenClaw?secret=${secret}&issuer=OpenClaw`;

  return {
    secret,
    uri,
  };
}
