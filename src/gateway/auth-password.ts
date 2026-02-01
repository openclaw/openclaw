import crypto from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(crypto.scrypt);

/** Salt length in bytes */
const SALT_LENGTH = 16;

/** Derived key length in bytes */
const KEY_LENGTH = 64;

/** Scrypt cost parameter (CPU/memory cost) */
const SCRYPT_N = 16384;

/** Scrypt block size parameter */
const SCRYPT_R = 8;

/** Scrypt parallelization parameter */
const SCRYPT_P = 1;

/**
 * Hash a password using scrypt.
 * Returns a string in the format: `salt:hash` (both hex-encoded).
 *
 * @param password - Plain text password to hash
 * @returns Hashed password string
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const derivedKey = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;

  return `${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

/**
 * Verify a password against a hashed password.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param password - Plain text password to verify
 * @param hash - Hashed password (in format `salt:hash`)
 * @returns True if password matches
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const parts = hash.split(":");
  if (parts.length !== 2) {
    return false;
  }

  const [saltHex, keyHex] = parts;
  if (!saltHex || !keyHex) {
    return false;
  }

  const salt = Buffer.from(saltHex, "hex");
  const storedKey = Buffer.from(keyHex, "hex");

  const derivedKey = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;

  return crypto.timingSafeEqual(storedKey, derivedKey);
}

/**
 * Check if a string looks like a hashed password (contains colon separator).
 *
 * @param value - String to check
 * @returns True if looks like hashed password
 */
export function isHashedPassword(value: string): boolean {
  return value.includes(":") && value.split(":").length === 2;
}

/**
 * Migrate a plain text password to hashed format.
 * If already hashed, returns as-is.
 *
 * @param password - Password (plain or hashed)
 * @returns Hashed password
 */
export async function migratePasswordToHashed(password: string): Promise<string> {
  if (isHashedPassword(password)) {
    return password;
  }
  return await hashPassword(password);
}
