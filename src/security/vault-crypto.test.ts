import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptCredentials,
  encryptCredentials,
  isEncryptedVault,
  loadOrCreateVaultKey,
} from "./vault-crypto.js";

describe("vault-crypto", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-crypto-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("loadOrCreateVaultKey", () => {
    it("generates a 32-byte key on first call and persists it", () => {
      const key = loadOrCreateVaultKey(tmpDir);
      expect(key.length).toBe(32);
      const keyPath = path.join(tmpDir, ".vault-key");
      expect(fs.existsSync(keyPath)).toBe(true);
      expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    });

    it("returns the same key on subsequent calls", () => {
      const k1 = loadOrCreateVaultKey(tmpDir);
      const k2 = loadOrCreateVaultKey(tmpDir);
      expect(k1.equals(k2)).toBe(true);
    });

    it("regenerates key and returns 32 bytes when key file is wrong size", () => {
      const keyPath = path.join(tmpDir, ".vault-key");
      fs.writeFileSync(keyPath, Buffer.alloc(16)); // wrong: 16 instead of 32
      const newKey = loadOrCreateVaultKey(tmpDir);
      expect(newKey.length).toBe(32);
      expect(fs.readFileSync(keyPath).length).toBe(32);
    });

    it("creates vaultDir if it does not exist", () => {
      const nested = path.join(tmpDir, "nested", "vault");
      const key = loadOrCreateVaultKey(nested);
      expect(key.length).toBe(32);
      expect(fs.existsSync(nested)).toBe(true);
    });
  });

  describe("isEncryptedVault", () => {
    it("returns true for an OCVAULT-formatted buffer", () => {
      const enc = encryptCredentials("test", tmpDir);
      expect(isEncryptedVault(enc)).toBe(true);
    });

    it("returns false for a plaintext JSON buffer", () => {
      const plain = Buffer.from(JSON.stringify({ key: "value" }));
      expect(isEncryptedVault(plain)).toBe(false);
    });

    it("returns false for an empty buffer", () => {
      expect(isEncryptedVault(Buffer.alloc(0))).toBe(false);
    });

    it("returns false for a short buffer that cannot contain the full header", () => {
      expect(isEncryptedVault(Buffer.from("OCVAULT"))).toBe(false);
    });
  });

  describe("encryptCredentials / decryptCredentials", () => {
    it("round-trips a JSON credentials payload", () => {
      const payload = JSON.stringify({ "provider:anthropic": "sk-ant-api03-testkey12345" });
      const enc = encryptCredentials(payload, tmpDir);
      expect(isEncryptedVault(enc)).toBe(true);
      const dec = decryptCredentials(enc, tmpDir);
      expect(dec).toBe(payload);
    });

    it("round-trips an empty store", () => {
      const enc = encryptCredentials("{}", tmpDir);
      expect(decryptCredentials(enc, tmpDir)).toBe("{}");
    });

    it("produces different ciphertext on each call (unique IV per encryption)", () => {
      const enc1 = encryptCredentials("same-payload", tmpDir);
      const enc2 = encryptCredentials("same-payload", tmpDir);
      expect(enc1.equals(enc2)).toBe(false);
    });

    it("rejects data without the OCVAULT magic header", () => {
      expect(() => decryptCredentials(Buffer.from("not-encrypted"), tmpDir)).toThrow(
        "not an OCVAULT-format file",
      );
    });

    it("rejects tampered ciphertext (GCM auth tag mismatch)", () => {
      const enc = encryptCredentials("secret-data", tmpDir);
      // Flip the last byte of ciphertext — auth tag will not match
      enc[enc.length - 1] ^= 0xff;
      expect(() => decryptCredentials(enc, tmpDir)).toThrow();
    });

    it("rejects ciphertext encrypted with a different key", () => {
      const enc = encryptCredentials("secret", tmpDir);

      // Replace the key on disk with a new random key
      const keyPath = path.join(tmpDir, ".vault-key");
      fs.writeFileSync(keyPath, Buffer.alloc(32, 0xaa), { mode: 0o600 });

      expect(() => decryptCredentials(enc, tmpDir)).toThrow();
    });
  });
});
