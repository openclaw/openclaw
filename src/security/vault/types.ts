export type EncryptedEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  kdf: "pbkdf2-sha512" | "argon2id" | "keychain";
  /** base64, 32 bytes — omitted when kdf=keychain */
  salt: string;
  /** base64, 12 bytes */
  iv: string;
  /** base64, 16 bytes */
  authTag: string;
  /** base64 */
  ciphertext: string;
};

export type VaultConfig = {
  /** Whether credential encryption is enabled. Default: true when keychain is available. */
  enabled?: boolean;
  /** Key storage backend. Default: "auto" (prefers keychain, falls back to passphrase). */
  backend?: "keychain" | "passphrase" | "auto";
  /** Auto-encrypt plaintext credentials on read. Default: true. */
  migrateOnLoad?: boolean;
};

export type VaultOptions = {
  backend: "keychain" | "passphrase" | "auto";
  stateDir: string;
  passphrase?: string;
};

export type Vault = {
  /** Encrypt plaintext and return a JSON envelope string. */
  encrypt(plaintext: string): Promise<string>;
  /** Decrypt a JSON envelope string and return plaintext. */
  decrypt(envelopeJson: string): Promise<string>;
  /** Check whether content looks like an encrypted envelope. */
  isEncrypted(content: string): boolean;
  /** Create or retrieve the encryption key. */
  ensureKey(): Promise<void>;
  /** Re-encrypt all data with a new key. */
  rotateKey(newPassphrase?: string): Promise<void>;
};

export const VAULT_KEYCHAIN_SERVICE = "ai.openclaw.vault";
export const VAULT_ENVELOPE_MARKER = '{"version":1,"algorithm":';
