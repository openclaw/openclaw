/**
 * AES-256-GCM encryption for the OpenClaw file-based credential vault.
 *
 * ## Key management
 * A 32-byte random key is generated on first use and persisted at
 * `<vaultDir>/.vault-key` (mode 0o600, owner-read/write only).
 * The key is machine-bound — it is NOT derived from a user passphrase.
 * If the key file is deleted, stored credentials cannot be recovered; users
 * must re-enter them.  This is acceptable because all stored values are API
 * keys / tokens that can be regenerated.
 *
 * ## Wire format
 * ```
 * magic(8) || iv(12) || tag(16) || ciphertext(n)
 * ```
 * - `magic` — ASCII "OCVAULT" + 0x01 version byte (8 bytes total)
 * - `iv`     — 12-byte random IV (AES-GCM standard)
 * - `tag`    — 16-byte GCM authentication tag
 * - `ciphertext` — AES-256-GCM output of the UTF-8 JSON payload
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// "OCVAULT" + 0x01 version byte
const MAGIC = Buffer.from([0x4f, 0x43, 0x56, 0x41, 0x55, 0x4c, 0x54, 0x01]);
const IV_LEN = 12; // AES-GCM standard
const TAG_LEN = 16; // AES-GCM standard auth tag
const KEY_LEN = 32; // AES-256
const VAULT_KEY_FILENAME = ".vault-key";

/** Returns true when `data` starts with the OCVAULT magic header. */
export function isEncryptedVault(data: Buffer): boolean {
  return data.length >= MAGIC.length && data.subarray(0, MAGIC.length).equals(MAGIC);
}

/**
 * Load the vault encryption key from `<vaultDir>/.vault-key`, generating and
 * persisting a new 32-byte random key if the file does not exist.
 * Throws on I/O error (e.g. unwritable directory).
 */
export function loadOrCreateVaultKey(vaultDir: string): Buffer {
  const keyPath = path.join(vaultDir, VAULT_KEY_FILENAME);

  if (fs.existsSync(keyPath)) {
    const key = fs.readFileSync(keyPath);
    if (key.length === KEY_LEN) {
      return key;
    }
    // Key file is the wrong size — regenerate.
    // Previously stored credentials will become unrecoverable; the migration
    // path in loadFileCredentials will return an empty store on the next read.
  }

  const key = randomBytes(KEY_LEN);
  if (!fs.existsSync(vaultDir)) {
    fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
  return key;
}

/**
 * Encrypt `plaintext` (UTF-8 JSON) using AES-256-GCM.
 * Returns a Buffer in OCVAULT wire format.
 */
export function encryptCredentials(plaintext: string, vaultDir: string): Buffer {
  const key = loadOrCreateVaultKey(vaultDir);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ciphertext]);
}

/**
 * Decrypt a Buffer in OCVAULT wire format.
 * Throws if the magic header is missing, the auth tag is invalid, or I/O fails.
 */
export function decryptCredentials(data: Buffer, vaultDir: string): string {
  if (!isEncryptedVault(data)) {
    throw new Error("not an OCVAULT-format file");
  }
  const key = loadOrCreateVaultKey(vaultDir);
  let offset = MAGIC.length;
  const iv = data.subarray(offset, offset + IV_LEN);
  offset += IV_LEN;
  const tag = data.subarray(offset, offset + TAG_LEN);
  offset += TAG_LEN;
  const ciphertext = data.subarray(offset);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  // Concatenate as Buffers before decoding to UTF-8 to avoid implicit latin1
  // coercion from Buffer + string arithmetic.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
