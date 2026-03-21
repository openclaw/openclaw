import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isFileEncrypted, readCredentialJson, writeCredentialJson } from "./credential-store.js";

function generateTestKeyPem(): string {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

describe("credential-store", () => {
  const privateKeyPem = generateTestKeyPem();
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cred-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("writeCredentialJson + readCredentialJson round-trip", () => {
    it("encrypts by default and decrypts transparently", () => {
      const filePath = path.join(tmpDir, "test.json");
      const data = { token: "secret-abc", expires: 12345 };

      writeCredentialJson(filePath, data, { privateKeyPem });
      const result = readCredentialJson(filePath, { privateKeyPem });
      expect(result).toEqual(data);
    });

    it("file on disk is an encrypted envelope", () => {
      const filePath = path.join(tmpDir, "test.json");
      const data = { key: "value" };

      writeCredentialJson(filePath, data, { privateKeyPem });
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      expect(raw.version).toBe(1);
      expect(raw.encryption).toBeDefined();
      expect(raw.encryption.algorithm).toBe("aes-256-gcm");
      expect(raw.ciphertext).toBeDefined();
    });

    it("writes plaintext when mode is plaintext", () => {
      const filePath = path.join(tmpDir, "test.json");
      const data = { token: "plaintext-secret" };

      writeCredentialJson(filePath, data, { privateKeyPem, mode: "plaintext" });
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      expect(raw).toEqual(data);
    });

    it("sets file permissions to 0o600", () => {
      const filePath = path.join(tmpDir, "test.json");
      writeCredentialJson(filePath, { key: "val" }, { privateKeyPem });
      const stats = fs.statSync(filePath);
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it("creates parent directories if needed", () => {
      const filePath = path.join(tmpDir, "nested", "dir", "test.json");
      writeCredentialJson(filePath, { key: "val" }, { privateKeyPem });
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });

  describe("transparent plaintext migration", () => {
    it("reads existing plaintext file without encryption", () => {
      const filePath = path.join(tmpDir, "legacy.json");
      const data = { token: "old-plaintext-token", version: 1, deviceId: "abc" };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");

      const result = readCredentialJson(filePath, { privateKeyPem });
      expect(result).toEqual(data);
    });

    it("migrates plaintext to encrypted on next write", () => {
      const filePath = path.join(tmpDir, "migrating.json");
      const data = { token: "migrating-token" };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");

      // Read succeeds (plaintext)
      const readResult = readCredentialJson(filePath, { privateKeyPem });
      expect(readResult).toEqual(data);

      // Write encrypts
      writeCredentialJson(filePath, data, { privateKeyPem });

      // File is now encrypted
      expect(isFileEncrypted(filePath)).toBe(true);

      // Read still succeeds (decrypts)
      const readAgain = readCredentialJson(filePath, { privateKeyPem });
      expect(readAgain).toEqual(data);
    });
  });

  describe("readCredentialJson edge cases", () => {
    it("returns undefined for non-existent file", () => {
      const result = readCredentialJson(path.join(tmpDir, "nope.json"), { privateKeyPem });
      expect(result).toBeUndefined();
    });

    it("returns undefined for invalid JSON", () => {
      const filePath = path.join(tmpDir, "bad.json");
      fs.writeFileSync(filePath, "not-json{{{", "utf8");
      const result = readCredentialJson(filePath, { privateKeyPem });
      expect(result).toBeUndefined();
    });

    it("returns undefined when encrypted with wrong key", () => {
      const otherKeyPem = generateTestKeyPem();
      const filePath = path.join(tmpDir, "wrong-key.json");
      writeCredentialJson(filePath, { secret: "value" }, { privateKeyPem });

      // Reading with the wrong key fails silently
      const result = readCredentialJson(filePath, { privateKeyPem: otherKeyPem });
      expect(result).toBeUndefined();
    });
  });

  describe("isFileEncrypted", () => {
    it("returns true for encrypted file", () => {
      const filePath = path.join(tmpDir, "enc.json");
      writeCredentialJson(filePath, { key: "val" }, { privateKeyPem });
      expect(isFileEncrypted(filePath)).toBe(true);
    });

    it("returns false for plaintext file", () => {
      const filePath = path.join(tmpDir, "plain.json");
      writeCredentialJson(filePath, { key: "val" }, { privateKeyPem, mode: "plaintext" });
      expect(isFileEncrypted(filePath)).toBe(false);
    });

    it("returns false for non-existent file", () => {
      expect(isFileEncrypted(path.join(tmpDir, "nope.json"))).toBe(false);
    });

    it("returns false for invalid JSON", () => {
      const filePath = path.join(tmpDir, "bad.json");
      fs.writeFileSync(filePath, "not-json", "utf8");
      expect(isFileEncrypted(filePath)).toBe(false);
    });
  });

  describe("mode switching", () => {
    it("can switch from encrypted to plaintext", () => {
      const filePath = path.join(tmpDir, "switch.json");
      const data = { token: "secret" };

      writeCredentialJson(filePath, data, { privateKeyPem, mode: "encrypted" });
      expect(isFileEncrypted(filePath)).toBe(true);

      writeCredentialJson(filePath, data, { privateKeyPem, mode: "plaintext" });
      expect(isFileEncrypted(filePath)).toBe(false);

      const result = readCredentialJson(filePath, { privateKeyPem });
      expect(result).toEqual(data);
    });

    it("can switch from plaintext to encrypted", () => {
      const filePath = path.join(tmpDir, "switch2.json");
      const data = { token: "secret" };

      writeCredentialJson(filePath, data, { privateKeyPem, mode: "plaintext" });
      expect(isFileEncrypted(filePath)).toBe(false);

      writeCredentialJson(filePath, data, { privateKeyPem, mode: "encrypted" });
      expect(isFileEncrypted(filePath)).toBe(true);

      const result = readCredentialJson(filePath, { privateKeyPem });
      expect(result).toEqual(data);
    });
  });
});
