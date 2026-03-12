import crypto from "node:crypto";

const LEGACY_ENCRYPTION_VERSION = 1;
const ENCRYPTION_VERSION = 2;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const PBKDF2_ITERATIONS = 210_000;
const PBKDF2_SALT = "openclaw.persistence.crypto.v2";

export type EncryptedJsonPayload = {
  version: number;
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
};

function deriveKey(secret: string): Buffer {
  return crypto.pbkdf2Sync(secret, PBKDF2_SALT, PBKDF2_ITERATIONS, KEY_BYTES, "sha256");
}

function deriveLegacyKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

export function encryptJsonValue(value: unknown, secret: string): EncryptedJsonPayload {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    version: ENCRYPTION_VERSION,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptJsonValue<T>(payload: EncryptedJsonPayload, secret: string): T {
  if (
    (payload.version !== LEGACY_ENCRYPTION_VERSION && payload.version !== ENCRYPTION_VERSION) ||
    payload.algorithm !== "aes-256-gcm"
  ) {
    throw new Error("Unsupported encrypted payload format.");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    payload.version === LEGACY_ENCRYPTION_VERSION ? deriveLegacyKey(secret) : deriveKey(secret),
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
