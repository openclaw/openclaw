import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_PREFIX = "ocpk_";

/**
 * Generate a platform API key for a tenant.
 * Format: ocpk_<32 random bytes as base64url>
 */
export function generatePlatformApiKey(): string {
  return `${KEY_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

/** SHA-256 hash for constant-time lookup in the key index. */
export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns base64-encoded ciphertext with IV and auth tag prepended.
 */
export function encryptSecret(plaintext: string, masterKey: string): string {
  const keyBuffer = deriveKeyBuffer(masterKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv + tag + ciphertext, all base64
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/**
 * Decrypt a base64-encoded ciphertext produced by encryptSecret.
 */
export function decryptSecret(encoded: string, masterKey: string): string {
  const keyBuffer = deriveKeyBuffer(masterKey);
  const data = Buffer.from(encoded, "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}

/** Derive a 32-byte key from the master key string. */
function deriveKeyBuffer(masterKey: string): Buffer {
  return crypto.createHash("sha256").update(masterKey).digest();
}

/**
 * Resolve the master encryption key from the environment.
 * Returns undefined if not configured (multi-tenant disabled).
 */
export function resolveMasterKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.OPENCLAW_TENANT_MASTER_KEY?.trim() || undefined;
}
