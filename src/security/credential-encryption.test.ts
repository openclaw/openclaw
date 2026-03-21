import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_ENCRYPTION_ALGORITHM,
  CREDENTIAL_ENCRYPTION_KDF,
  CREDENTIAL_ENCRYPTION_KDF_INFO,
  CREDENTIAL_ENCRYPTION_VERSION,
  decryptCredential,
  deriveEncryptionKey,
  encryptCredential,
  isEncryptedEnvelope,
  type EncryptedCredentialEnvelope,
} from "./credential-encryption.js";

function generateTestKeyPem(): string {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

describe("credential-encryption", () => {
  const privateKeyPem = generateTestKeyPem();

  describe("deriveEncryptionKey", () => {
    it("derives a 32-byte key", () => {
      const salt = crypto.randomBytes(32);
      const key = deriveEncryptionKey(privateKeyPem, salt);
      expect(Buffer.from(key).length).toBe(32);
    });

    it("produces different keys for different salts", () => {
      const salt1 = crypto.randomBytes(32);
      const salt2 = crypto.randomBytes(32);
      const key1 = deriveEncryptionKey(privateKeyPem, salt1);
      const key2 = deriveEncryptionKey(privateKeyPem, salt2);
      expect(Buffer.from(key1).equals(Buffer.from(key2))).toBe(false);
    });

    it("produces deterministic output for same inputs", () => {
      const salt = crypto.randomBytes(32);
      const key1 = deriveEncryptionKey(privateKeyPem, salt);
      const key2 = deriveEncryptionKey(privateKeyPem, salt);
      expect(Buffer.from(key1).equals(Buffer.from(key2))).toBe(true);
    });

    it("produces different keys for different private keys", () => {
      const otherKeyPem = generateTestKeyPem();
      const salt = crypto.randomBytes(32);
      const key1 = deriveEncryptionKey(privateKeyPem, salt);
      const key2 = deriveEncryptionKey(otherKeyPem, salt);
      expect(Buffer.from(key1).equals(Buffer.from(key2))).toBe(false);
    });
  });

  describe("encryptCredential / decryptCredential round-trip", () => {
    it("round-trips a simple JSON string", () => {
      const plaintext = JSON.stringify({ token: "secret-123", expires: 9999 });
      const envelope = encryptCredential(plaintext, privateKeyPem);
      const decrypted = decryptCredential(envelope, privateKeyPem);
      expect(decrypted).toBe(plaintext);
    });

    it("round-trips empty object", () => {
      const plaintext = "{}";
      const envelope = encryptCredential(plaintext, privateKeyPem);
      const decrypted = decryptCredential(envelope, privateKeyPem);
      expect(decrypted).toBe(plaintext);
    });

    it("round-trips large payloads", () => {
      const data = {
        profiles: Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => [`key-${i}`, `value-${"x".repeat(500)}`]),
        ),
      };
      const plaintext = JSON.stringify(data);
      const envelope = encryptCredential(plaintext, privateKeyPem);
      const decrypted = decryptCredential(envelope, privateKeyPem);
      expect(decrypted).toBe(plaintext);
    });

    it("round-trips unicode content", () => {
      const plaintext = JSON.stringify({ name: "test 🔐 credential 日本語" });
      const envelope = encryptCredential(plaintext, privateKeyPem);
      const decrypted = decryptCredential(envelope, privateKeyPem);
      expect(decrypted).toBe(plaintext);
    });

    it("produces different ciphertexts for same plaintext (random IV/salt)", () => {
      const plaintext = JSON.stringify({ token: "same-secret" });
      const envelope1 = encryptCredential(plaintext, privateKeyPem);
      const envelope2 = encryptCredential(plaintext, privateKeyPem);
      expect(envelope1.ciphertext).not.toBe(envelope2.ciphertext);
      expect(envelope1.encryption.salt).not.toBe(envelope2.encryption.salt);
      expect(envelope1.encryption.iv).not.toBe(envelope2.encryption.iv);
    });
  });

  describe("decryption failure modes", () => {
    it("rejects wrong private key", () => {
      const otherKeyPem = generateTestKeyPem();
      const plaintext = JSON.stringify({ secret: "value" });
      const envelope = encryptCredential(plaintext, privateKeyPem);
      expect(() => decryptCredential(envelope, otherKeyPem)).toThrow();
    });

    it("rejects tampered ciphertext", () => {
      const plaintext = JSON.stringify({ secret: "value" });
      const envelope = encryptCredential(plaintext, privateKeyPem);
      const tampered: EncryptedCredentialEnvelope = {
        ...envelope,
        ciphertext: Buffer.from("tampered-data").toString("base64"),
      };
      expect(() => decryptCredential(tampered, privateKeyPem)).toThrow();
    });

    it("rejects tampered auth tag", () => {
      const plaintext = JSON.stringify({ secret: "value" });
      const envelope = encryptCredential(plaintext, privateKeyPem);
      const tamperedTag = crypto.randomBytes(16).toString("base64");
      const tampered: EncryptedCredentialEnvelope = {
        ...envelope,
        encryption: { ...envelope.encryption, tag: tamperedTag },
      };
      expect(() => decryptCredential(tampered, privateKeyPem)).toThrow();
    });

    it("rejects tampered IV", () => {
      const plaintext = JSON.stringify({ secret: "value" });
      const envelope = encryptCredential(plaintext, privateKeyPem);
      const tamperedIv = crypto.randomBytes(12).toString("base64");
      const tampered: EncryptedCredentialEnvelope = {
        ...envelope,
        encryption: { ...envelope.encryption, iv: tamperedIv },
      };
      expect(() => decryptCredential(tampered, privateKeyPem)).toThrow();
    });
  });

  describe("isEncryptedEnvelope", () => {
    it("returns true for valid envelope", () => {
      const envelope = encryptCredential("{}", privateKeyPem);
      expect(isEncryptedEnvelope(envelope)).toBe(true);
    });

    it("returns false for null/undefined", () => {
      expect(isEncryptedEnvelope(null)).toBe(false);
      expect(isEncryptedEnvelope(undefined)).toBe(false);
    });

    it("returns false for plaintext JSON", () => {
      expect(isEncryptedEnvelope({ token: "secret" })).toBe(false);
    });

    it("returns false for wrong version", () => {
      const envelope = encryptCredential("{}", privateKeyPem);
      expect(isEncryptedEnvelope({ ...envelope, version: 2 })).toBe(false);
    });

    it("returns false for missing encryption field", () => {
      expect(
        isEncryptedEnvelope({
          version: CREDENTIAL_ENCRYPTION_VERSION,
          ciphertext: "abc",
        }),
      ).toBe(false);
    });

    it("returns false for wrong algorithm", () => {
      const envelope = encryptCredential("{}", privateKeyPem);
      expect(
        isEncryptedEnvelope({
          ...envelope,
          encryption: { ...envelope.encryption, algorithm: "aes-128-cbc" },
        }),
      ).toBe(false);
    });
  });

  describe("envelope structure", () => {
    it("contains expected metadata fields", () => {
      const envelope = encryptCredential("{}", privateKeyPem);
      expect(envelope.version).toBe(CREDENTIAL_ENCRYPTION_VERSION);
      expect(envelope.encryption.algorithm).toBe(CREDENTIAL_ENCRYPTION_ALGORITHM);
      expect(envelope.encryption.kdf).toBe(CREDENTIAL_ENCRYPTION_KDF);
      expect(envelope.encryption.kdfInfo).toBe(CREDENTIAL_ENCRYPTION_KDF_INFO);
      expect(typeof envelope.encryption.salt).toBe("string");
      expect(typeof envelope.encryption.iv).toBe("string");
      expect(typeof envelope.encryption.tag).toBe("string");
      expect(typeof envelope.ciphertext).toBe("string");
    });

    it("salt is base64 of 32 bytes", () => {
      const envelope = encryptCredential("{}", privateKeyPem);
      const saltBytes = Buffer.from(envelope.encryption.salt, "base64");
      expect(saltBytes.length).toBe(32);
    });

    it("iv is base64 of 12 bytes", () => {
      const envelope = encryptCredential("{}", privateKeyPem);
      const ivBytes = Buffer.from(envelope.encryption.iv, "base64");
      expect(ivBytes.length).toBe(12);
    });

    it("tag is base64 of 16 bytes", () => {
      const envelope = encryptCredential("{}", privateKeyPem);
      const tagBytes = Buffer.from(envelope.encryption.tag, "base64");
      expect(tagBytes.length).toBe(16);
    });
  });
});
