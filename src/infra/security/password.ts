/**
 * Password hashing utilities
 *
 * Uses Node.js crypto scrypt for secure password hashing.
 */

import crypto from "node:crypto";

/** Salt length in bytes */
const SALT_LENGTH = 16;

/** Key length in bytes */
const KEY_LENGTH = 64;

/** Scrypt parameters */
const SCRYPT_OPTIONS: crypto.ScryptOptions = {
  N: 16384, // CPU/memory cost parameter (2^14)
  r: 8, // Block size parameter
  p: 1, // Parallelization parameter
};

/**
 * Hash a password using scrypt.
 */
export async function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(SALT_LENGTH);

    crypto.scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }

      // Format: $scrypt$N$r$p$salt$hash
      const saltB64 = salt.toString("base64");
      const hashB64 = derivedKey.toString("base64");
      const hash = `$scrypt$${SCRYPT_OPTIONS.N}$${SCRYPT_OPTIONS.r}$${SCRYPT_OPTIONS.p}$${saltB64}$${hashB64}`;

      resolve(hash);
    });
  });
}

/**
 * Verify a password against a scrypt hash.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    // Parse the hash
    const parts = hash.split("$");
    if (parts.length !== 7 || parts[1] !== "scrypt") {
      resolve(false);
      return;
    }

    const N = parseInt(parts[2], 10);
    const r = parseInt(parts[3], 10);
    const p = parseInt(parts[4], 10);
    const salt = Buffer.from(parts[5], "base64");
    const expectedHash = Buffer.from(parts[6], "base64");

    crypto.scrypt(password, salt, KEY_LENGTH, { N, r, p }, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }

      // Constant-time comparison
      resolve(crypto.timingSafeEqual(derivedKey, expectedHash));
    });
  });
}

/**
 * Check if a string looks like a scrypt hash.
 */
export function isScryptHash(value: string): boolean {
  return value.startsWith("$scrypt$");
}
