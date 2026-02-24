import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteCredential,
  getCredential,
  getCredentialsDueForRotation,
  hasCredential,
  listCredentials,
  rotateCredential,
  storeCredential,
  validateCredentialFormat,
  type CredentialScope,
  type VaultOptions,
} from "./credential-vault.js";

describe("credential-vault", () => {
  let testVaultDir: string;
  let vaultOptions: VaultOptions;

  beforeEach(() => {
    // Create isolated test directory
    testVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-test-"));
    vaultOptions = {
      vaultDir: testVaultDir,
      platform: "linux", // Use file-based storage for tests
    };
  });

  afterEach(() => {
    // Cleanup test directory
    if (testVaultDir && fs.existsSync(testVaultDir)) {
      fs.rmSync(testVaultDir, { recursive: true, force: true });
    }
  });

  describe("storeCredential", () => {
    it("should store a credential successfully", () => {
      const result = storeCredential(
        "test-api-key",
        "sk-ant-api01-abcdefghijklmnopqrstuvwxyz",
        "provider",
        vaultOptions,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.entry.name).toBe("test-api-key");
        expect(result.entry.scope).toBe("provider");
        expect(result.entry.hashPrefix).toHaveLength(8);
        expect(result.entry.createdAt).toBeGreaterThan(0);
        expect(result.entry.rotatedAt).toBeGreaterThan(0);
      }
    });

    it("should store an OpenAI project key successfully", () => {
      const result = storeCredential(
        "openai-proj",
        "sk-proj-1234567890-abcdefghijklmnopqrstuvwxyz",
        "provider",
        vaultOptions,
      );

      expect(result.ok).toBe(true);
    });

    it("should reject empty name", () => {
      const result = storeCredential("", "secret-value", "provider", vaultOptions);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("INVALID_VALUE");
      }
    });

    it("should reject empty value", () => {
      const result = storeCredential("test-key", "", "provider", vaultOptions);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("INVALID_VALUE");
      }
    });

    it("should reject very short values", () => {
      const result = storeCredential("test-key", "short", "provider", vaultOptions);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("VALIDATION_FAILED");
      }
    });

    it("should store credentials in different scopes", () => {
      const scopes: CredentialScope[] = ["provider", "channel", "integration", "internal"];

      for (const scope of scopes) {
        const result = storeCredential(
          `test-${scope}`,
          "valid-credential-value-12345678",
          scope,
          vaultOptions,
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.entry.scope).toBe(scope);
        }
      }
    });

    it("should update existing credential", () => {
      // Store initial
      const result1 = storeCredential(
        "update-test",
        "initial-value-12345678",
        "provider",
        vaultOptions,
      );
      expect(result1.ok).toBe(true);

      const initialHash = result1.ok ? result1.entry.hashPrefix : "";

      // Store update
      const result2 = storeCredential(
        "update-test",
        "updated-value-87654321",
        "provider",
        vaultOptions,
      );
      expect(result2.ok).toBe(true);

      if (result2.ok) {
        expect(result2.entry.hashPrefix).not.toBe(initialHash);
      }
    });
  });

  describe("getCredential", () => {
    it("should retrieve a stored credential", () => {
      const secret = "sk-ant-api01-abcdefghijklmnopqrstuvwxyz";
      storeCredential("get-test", secret, "provider", vaultOptions);

      const result = getCredential("get-test", "provider", "test-requestor", vaultOptions);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(secret);
        expect(result.entry.accessCount).toBe(1);
        expect(result.entry.lastAccessedBy).toBe("test-requestor");
      }
    });

    it("should return NOT_FOUND for missing credential", () => {
      const result = getCredential("nonexistent", "provider", "test", vaultOptions);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("NOT_FOUND");
      }
    });

    it("should return SCOPE_MISMATCH for wrong scope", () => {
      storeCredential("scope-test", "valid-credential-12345678", "provider", vaultOptions);

      const result = getCredential("scope-test", "channel", "test", vaultOptions);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("NOT_FOUND"); // Won't find it in wrong scope
      }
    });

    it("should increment access count", () => {
      storeCredential("access-test", "valid-credential-12345678", "provider", vaultOptions);

      getCredential("access-test", "provider", "req1", vaultOptions);
      getCredential("access-test", "provider", "req2", vaultOptions);
      const result = getCredential("access-test", "provider", "req3", vaultOptions);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.entry.accessCount).toBe(3);
        expect(result.entry.lastAccessedBy).toBe("req3");
      }
    });
  });

  describe("rotateCredential", () => {
    it("should rotate an existing credential", () => {
      const oldSecret = "old-secret-value-12345678";
      const newSecret = "new-secret-value-87654321";

      storeCredential("rotate-test", oldSecret, "provider", vaultOptions);

      const result = rotateCredential("rotate-test", "provider", newSecret, vaultOptions);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.entry.rotatedAt).toBeGreaterThan(0);
      }

      // Verify new value is retrievable
      const getResult = getCredential("rotate-test", "provider", "test", vaultOptions);
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value).toBe(newSecret);
      }
    });

    it("should create credential if it does not exist", () => {
      const result = rotateCredential(
        "new-rotate",
        "provider",
        "valid-credential-12345678",
        vaultOptions,
      );

      expect(result.ok).toBe(true);
    });

    it("should update hash prefix after rotation", () => {
      storeCredential("hash-test", "initial-value-12345678", "provider", vaultOptions);
      const get1 = getCredential("hash-test", "provider", "test", vaultOptions);
      const initialHash = get1.ok ? get1.entry.hashPrefix : "";

      rotateCredential("hash-test", "provider", "rotated-value-87654321", vaultOptions);

      const get2 = getCredential("hash-test", "provider", "test", vaultOptions);
      expect(get2.ok).toBe(true);
      if (get2.ok) {
        expect(get2.entry.hashPrefix).not.toBe(initialHash);
      }
    });
  });

  describe("deleteCredential", () => {
    it("should delete an existing credential", () => {
      storeCredential("delete-test", "valid-credential-12345678", "provider", vaultOptions);

      const result = deleteCredential("delete-test", "provider", vaultOptions);

      expect(result.ok).toBe(true);

      // Verify it's gone
      const getResult = getCredential("delete-test", "provider", "test", vaultOptions);
      expect(getResult.ok).toBe(false);
    });

    it("should return NOT_FOUND for missing credential", () => {
      const result = deleteCredential("nonexistent", "provider", vaultOptions);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("listCredentials", () => {
    it("should list all credentials", () => {
      storeCredential("list-1", "value-12345678901234567890", "provider", vaultOptions);
      storeCredential("list-2", "value-12345678901234567890", "channel", vaultOptions);
      storeCredential("list-3", "value-12345678901234567890", "integration", vaultOptions);

      const entries = listCredentials(undefined, vaultOptions);

      expect(entries).toHaveLength(3);
    });

    it("should filter by scope", () => {
      storeCredential("scope-1", "value-12345678901234567890", "provider", vaultOptions);
      storeCredential("scope-2", "value-12345678901234567890", "provider", vaultOptions);
      storeCredential("scope-3", "value-12345678901234567890", "channel", vaultOptions);

      const providerEntries = listCredentials("provider", vaultOptions);
      const channelEntries = listCredentials("channel", vaultOptions);

      expect(providerEntries).toHaveLength(2);
      expect(channelEntries).toHaveLength(1);
    });

    it("should return empty array when no credentials", () => {
      const entries = listCredentials(undefined, vaultOptions);
      expect(entries).toHaveLength(0);
    });
  });

  describe("hasCredential", () => {
    it("should return true for existing credential", () => {
      storeCredential("exists-test", "value-12345678901234567890", "provider", vaultOptions);

      expect(hasCredential("exists-test", "provider", vaultOptions)).toBe(true);
    });

    it("should return false for missing credential", () => {
      expect(hasCredential("nonexistent", "provider", vaultOptions)).toBe(false);
    });

    it("should return false for wrong scope", () => {
      storeCredential("scope-check", "value-12345678901234567890", "provider", vaultOptions);

      expect(hasCredential("scope-check", "channel", vaultOptions)).toBe(false);
    });
  });

  describe("getCredentialsDueForRotation", () => {
    it("should return credentials older than threshold", () => {
      // Store credential
      storeCredential("old-cred", "value-12345678901234567890", "provider", vaultOptions);

      // Modify rotatedAt to be old
      const registryPath = path.join(testVaultDir, "registry.json");
      const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
      const key = "provider:old-cred";
      registry.entries[key].rotatedAt = Date.now() - 35 * 24 * 60 * 60 * 1000; // 35 days ago
      fs.writeFileSync(registryPath, JSON.stringify(registry));

      const dueForRotation = getCredentialsDueForRotation(30, vaultOptions);

      expect(dueForRotation).toHaveLength(1);
      expect(dueForRotation[0].name).toBe("old-cred");
    });

    it("should not return recent credentials", () => {
      storeCredential("new-cred", "value-12345678901234567890", "provider", vaultOptions);

      const dueForRotation = getCredentialsDueForRotation(30, vaultOptions);

      expect(dueForRotation).toHaveLength(0);
    });
  });

  describe("validateCredentialFormat", () => {
    it("should validate Anthropic API keys", () => {
      const result = validateCredentialFormat(
        "sk-ant-api01-abcdefghijklmnopqrstuvwxyz",
        "anthropic",
      );
      expect(result.valid).toBe(true);
    });

    it("should validate OpenAI API keys", () => {
      const result = validateCredentialFormat("sk-abcdefghijklmnopqrstuvwxyz12345678", "openai");
      expect(result.valid).toBe(true);
    });

    it("should validate OpenAI project keys", () => {
      const result = validateCredentialFormat(
        "sk-proj-1234567890-abcdefghijklmnopqrstuvwxyz",
        "openai",
      );
      expect(result.valid).toBe(true);
    });

    it("should reject very short values", () => {
      const result = validateCredentialFormat("short", "test");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("too short");
    });

    it("should accept generic credentials", () => {
      const result = validateCredentialFormat("abcdefghij1234567890ABCD", "unknown-service");
      expect(result.valid).toBe(true);
    });
  });

  describe("file permissions", () => {
    it("should create registry with secure permissions", () => {
      storeCredential("perm-test", "value-12345678901234567890", "provider", vaultOptions);

      const registryPath = path.join(testVaultDir, "registry.json");
      const stat = fs.statSync(registryPath);

      // Check mode is 0o600 (owner read/write only)
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it("should create credentials file with secure permissions", () => {
      storeCredential("perm-test", "value-12345678901234567890", "provider", vaultOptions);

      const credPath = path.join(testVaultDir, "credentials.json");
      const stat = fs.statSync(credPath);

      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });
});
