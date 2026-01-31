import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadEncryptedJsonFile,
  saveEncryptedJsonFile,
  isFileEncrypted,
  setEncryptionVault,
  isEncryptionEnabled,
} from "./encrypted-json-file.js";
import { CredentialVault } from "./credential-vault.js";
import { FileKeyProvider } from "./key-management.js";

describe("encrypted-json-file", () => {
  let tempDir: string;
  let testFile: string;
  let vault: CredentialVault;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-"));
    testFile = path.join(tempDir, "test.json");

    const keyProvider = new FileKeyProvider(path.join(tempDir, "test.key"));
    vault = new CredentialVault(keyProvider);
    setEncryptionVault(vault);
  });

  afterEach(() => {
    setEncryptionVault(null);
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe("saveEncryptedJsonFile and loadEncryptedJsonFile", () => {
    it("should save and load encrypted data", async () => {
      const data = { username: "test", password: "secret" };

      await saveEncryptedJsonFile(testFile, data);
      expect(fs.existsSync(testFile)).toBe(true);

      const loaded = await loadEncryptedJsonFile(testFile);
      expect(loaded).toEqual(data);
    });

    it("should encrypt complex auth profiles", async () => {
      const authData = {
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-1234567890abcdef",
          },
          "anthropic:work": {
            type: "oauth",
            provider: "anthropic",
            access: "access-token-123",
            refresh: "refresh-token-456",
          },
        },
        order: {
          openai: ["default"],
          anthropic: ["work"],
        },
      };

      await saveEncryptedJsonFile(testFile, authData);
      const loaded = await loadEncryptedJsonFile(testFile);

      expect(loaded).toEqual(authData);
    });

    it("should save as plaintext when encryption disabled", async () => {
      setEncryptionVault(null);

      const data = { test: "value" };
      await saveEncryptedJsonFile(testFile, data);

      // Should be readable as plain JSON
      const rawContent = JSON.parse(fs.readFileSync(testFile, "utf8"));
      expect(rawContent).toEqual(data);
    });

    it("should load plaintext files when encryption enabled", async () => {
      // First save without encryption
      setEncryptionVault(null);
      const plaintextData = { plaintext: "unencrypted-value" };
      fs.writeFileSync(testFile, JSON.stringify(plaintextData));

      // Then load with encryption enabled - should return plaintext as-is
      // since it's not detected as encrypted format
      setEncryptionVault(vault);
      const loaded = await loadEncryptedJsonFile(testFile);
      expect(loaded).toEqual(plaintextData);
    });
  });

  describe("isFileEncrypted", () => {
    it("should detect encrypted files", async () => {
      const data = { secret: "value" };

      await saveEncryptedJsonFile(testFile, data);
      expect(await isFileEncrypted(testFile)).toBe(true);
    });

    it("should detect plaintext files", async () => {
      // Write plaintext directly (not through saveEncryptedJsonFile)
      const data = { test: "value" };
      fs.writeFileSync(testFile, JSON.stringify(data));
      expect(await isFileEncrypted(testFile)).toBe(false);
    });

    it("should return false for non-existent files", async () => {
      expect(await isFileEncrypted("/path/that/does/not/exist.json")).toBe(false);
    });
  });

  describe("encryption vault management", () => {
    it("should track encryption status", () => {
      expect(isEncryptionEnabled()).toBe(true);

      setEncryptionVault(null);
      expect(isEncryptionEnabled()).toBe(false);

      setEncryptionVault(vault);
      expect(isEncryptionEnabled()).toBe(true);
    });
  });

  describe("error handling", () => {
    it("should throw on corrupted encrypted files", async () => {
      // Write invalid encrypted data
      const corruptedData = {
        version: 2,
        encryption: { algorithm: "aes-256-gcm", iv: "dGVzdA==", authTag: "dGVzdGF1dGh0YWcxMg==" },
        data: "corrupted-data",
      };

      fs.writeFileSync(testFile, JSON.stringify(corruptedData));

      // Should throw error - don't silently return corrupted data
      await expect(loadEncryptedJsonFile(testFile)).rejects.toThrow();
    });

    it("should throw when decryption fails with wrong key", async () => {
      // Create encrypted data with one key
      const data = { test: "secret" };
      await saveEncryptedJsonFile(testFile, data);

      // Create new vault with different key
      const newKeyProvider = new FileKeyProvider(path.join(tempDir, "different.key"));
      const newVault = new CredentialVault(newKeyProvider);
      setEncryptionVault(newVault);

      // Should throw error - don't silently return encrypted blob
      await expect(loadEncryptedJsonFile(testFile)).rejects.toThrow();
    });
  });
});
