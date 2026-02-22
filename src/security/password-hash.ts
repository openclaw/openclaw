/**
 * Password hashing for gateway authentication.
 *
 * Uses bcrypt with cost factor 12. Supports both bcrypt hashes (prefixed
 * with "$2a$" or "$2b$") and legacy plaintext passwords for migration.
 */

import { timingSafeEqual, createHash } from "node:crypto";
import bcrypt from "bcryptjs";

const BCRYPT_COST_FACTOR = 12;
const BCRYPT_PREFIX_RE = /^\$2[aby]\$/;

/**
 * Hash a plaintext password for storage in config.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_COST_FACTOR);
}

/**
 * Verify a password against a stored value.
 *
 * If the stored value is a bcrypt hash, uses bcrypt.compare.
 * If the stored value is plaintext (legacy), falls back to timing-safe
 * comparison and logs a deprecation warning.
 */
export async function verifyPassword(
  provided: string,
  stored: string,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  if (BCRYPT_PREFIX_RE.test(stored)) {
    const ok = await bcrypt.compare(provided, stored);
    return { ok, needsRehash: false };
  }

  // Legacy plaintext comparison — timing-safe to prevent timing attacks.
  const hashA = createHash("sha256").update(provided).digest();
  const hashB = createHash("sha256").update(stored).digest();
  const ok = timingSafeEqual(hashA, hashB);
  return { ok, needsRehash: ok };
}

/**
 * Check if a stored password value is already a bcrypt hash.
 */
export function isHashedPassword(value: string): boolean {
  return BCRYPT_PREFIX_RE.test(value);
}
