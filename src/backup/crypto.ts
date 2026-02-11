/**
 * AES-256-GCM encryption/decryption for backup archives.
 *
 * Uses `node:crypto` exclusively — zero external dependencies.
 *
 * @module backup/crypto
 */
import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM recommended
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32; // 256 bits

/**
 * Wire format:
 *   [salt 32B][iv 12B][authTag 16B][ciphertext ...]
 */

/**
 * Derive a 256-bit key from a passphrase via PBKDF2.
 */
function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha512");
}

/**
 * Encrypt data with a passphrase.
 */
export function encrypt(data: Buffer, passphrase: string): Buffer {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(passphrase, salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([salt, iv, authTag, encrypted]);
}

/**
 * Decrypt data with a passphrase.
 */
export function decrypt(data: Buffer, passphrase: string): Buffer {
  if (data.length < SALT_LENGTH + IV_LENGTH + TAG_LENGTH) {
    throw new Error("encrypted data too short");
  }

  const salt = data.subarray(0, SALT_LENGTH);
  const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

  const key = deriveKey(passphrase, salt);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
