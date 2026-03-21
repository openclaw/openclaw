import crypto from "node:crypto";

/**
 * AES-256-GCM credential encryption primitives.
 *
 * Key derivation uses HKDF-SHA256 from the device Ed25519 private key (PKCS8 DER)
 * with a per-file random salt. This provides per-file unique keys while using the
 * existing device identity as the root of trust.
 */

export const CREDENTIAL_ENCRYPTION_VERSION = 1;
export const CREDENTIAL_ENCRYPTION_ALGORITHM = "aes-256-gcm" as const;
export const CREDENTIAL_ENCRYPTION_KDF = "hkdf-sha256" as const;
export const CREDENTIAL_ENCRYPTION_KDF_INFO = "openclaw-credential-encryption-v1";

const AES_KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;

export type EncryptedCredentialEnvelope = {
  version: typeof CREDENTIAL_ENCRYPTION_VERSION;
  encryption: {
    algorithm: typeof CREDENTIAL_ENCRYPTION_ALGORITHM;
    kdf: typeof CREDENTIAL_ENCRYPTION_KDF;
    kdfInfo: string;
    salt: string;
    iv: string;
    tag: string;
  };
  ciphertext: string;
};

export function isEncryptedEnvelope(data: unknown): data is EncryptedCredentialEnvelope {
  if (!data || typeof data !== "object") {
    return false;
  }
  const record = data as Record<string, unknown>;
  if (record.version !== CREDENTIAL_ENCRYPTION_VERSION) {
    return false;
  }
  const encryption = record.encryption;
  if (!encryption || typeof encryption !== "object") {
    return false;
  }
  const enc = encryption as Record<string, unknown>;
  return (
    enc.algorithm === CREDENTIAL_ENCRYPTION_ALGORITHM &&
    enc.kdf === CREDENTIAL_ENCRYPTION_KDF &&
    typeof enc.salt === "string" &&
    typeof enc.iv === "string" &&
    typeof enc.tag === "string" &&
    typeof record.ciphertext === "string"
  );
}

/**
 * Derive a per-file AES-256 key from the device private key using HKDF-SHA256.
 *
 * The private key is exported as PKCS8 DER to get consistent raw bytes.
 * A per-file salt ensures each encrypted file uses a unique derived key.
 */
export function deriveEncryptionKey(privateKeyPem: string, salt: Buffer): Buffer {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const pkcs8Der = privateKey.export({ type: "pkcs8", format: "der" });
  return Buffer.from(
    crypto.hkdfSync("sha256", pkcs8Der, salt, CREDENTIAL_ENCRYPTION_KDF_INFO, AES_KEY_LENGTH),
  );
}

/**
 * Encrypt a plaintext JSON payload to an encrypted envelope.
 */
export function encryptCredential(
  plaintext: string,
  privateKeyPem: string,
): EncryptedCredentialEnvelope {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveEncryptionKey(privateKeyPem, salt);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: CREDENTIAL_ENCRYPTION_VERSION,
    encryption: {
      algorithm: CREDENTIAL_ENCRYPTION_ALGORITHM,
      kdf: CREDENTIAL_ENCRYPTION_KDF,
      kdfInfo: CREDENTIAL_ENCRYPTION_KDF_INFO,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
    },
    ciphertext: encrypted.toString("base64"),
  };
}

/**
 * Decrypt an encrypted credential envelope back to plaintext.
 *
 * Throws on corruption, wrong key, or tampered data (GCM auth tag verification).
 */
export function decryptCredential(
  envelope: EncryptedCredentialEnvelope,
  privateKeyPem: string,
): string {
  const salt = Buffer.from(envelope.encryption.salt, "base64");
  const iv = Buffer.from(envelope.encryption.iv, "base64");
  const tag = Buffer.from(envelope.encryption.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");

  const key = deriveEncryptionKey(privateKeyPem, salt);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}
