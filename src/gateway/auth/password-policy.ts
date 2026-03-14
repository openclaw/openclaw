/**
 * PasswordPolicy — GovDOSS™ / CMMC CP-7 password controls.
 *
 * Uses Node.js built-in `crypto.scrypt` (memory-hard KDF, NIST-approved) for
 * password hashing. The algorithm is equivalent to bcrypt in security
 * properties and requires no external dependencies.
 *
 * Default scrypt parameters: N=65536 (2^16), r=8, p=1 — approximately
 * equivalent to bcrypt cost factor 12 in terms of compute time.
 */

import { randomBytes, scrypt, ScryptOptions, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Scrypt parameters (adjust only after security review)
// ---------------------------------------------------------------------------

const SCRYPT_N = 65536; // CPU/memory cost (2^16)
const SCRYPT_R = 8; // block size
const SCRYPT_P = 1; // parallelisation
const SCRYPT_KEY_LEN = 64; // output length in bytes
const SALT_LEN = 32; // random salt length in bytes
// maxmem must cover 128 * N * r bytes. Set generously above that floor.
const SCRYPT_MAXMEM = 256 * 1024 * 1024; // 256 MB

/** Typed wrapper around `crypto.scrypt` to avoid promisify overload issues. */
function scryptDeriveKey(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Password strength validation
// ---------------------------------------------------------------------------

export type PasswordValidationResult = { valid: true } | { valid: false; errors: string[] };

export const PASSWORD_POLICY = {
  minLength: 12,
  requireUppercase: true,
  requireLowercase: true,
  requireDigit: true,
  requireSpecial: true,
} as const;

/**
 * Validates password strength against the configured policy.
 * Returns a typed result so callers can present specific error messages.
 */
export function validatePasswordStrength(password: string): PasswordValidationResult {
  const errors: string[] = [];

  if (password.length < PASSWORD_POLICY.minLength) {
    errors.push(`Must be at least ${PASSWORD_POLICY.minLength} characters`);
  }
  if (PASSWORD_POLICY.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push("Must contain at least one uppercase letter");
  }
  if (PASSWORD_POLICY.requireLowercase && !/[a-z]/.test(password)) {
    errors.push("Must contain at least one lowercase letter");
  }
  if (PASSWORD_POLICY.requireDigit && !/\d/.test(password)) {
    errors.push("Must contain at least one digit");
  }
  if (PASSWORD_POLICY.requireSpecial && !/[^A-Za-z0-9]/.test(password)) {
    errors.push("Must contain at least one special character");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Hashing and verification
// ---------------------------------------------------------------------------

/**
 * Hashes a password using scrypt and returns a self-contained encoded string:
 *   `scrypt:N:r:p:salt_hex:hash_hex`
 *
 * The encoded parameters are stored with the hash so that future parameter
 * changes don't break existing verifications.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await scryptDeriveKey(password, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

/**
 * Verifies a plaintext password against a stored hash string.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }

  const [, rawN, rawR, rawP, saltHex, hashHex] = parts;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);

  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  if (!saltHex || !hashHex) {
    return false;
  }

  const salt = Buffer.from(saltHex, "hex");
  const expectedHash = Buffer.from(hashHex, "hex");

  try {
    const actualHash = await scryptDeriveKey(password, salt, expectedHash.length, {
      N,
      r,
      p,
      maxmem: N * r * 256, // 2× the required memory floor for the given params
    });
    return timingSafeEqual(actualHash, expectedHash);
  } catch {
    return false;
  }
}
