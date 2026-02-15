import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadKeyring,
  resolveKeyringPath,
  findKeyByPubkey,
  getActiveKeys,
  isKeyAuthorized,
  clearKeyringCaches,
  KEYRING_SCHEMA,
  type KeyringPayload,
} from "./agentshield-keyring.js";
import { clearTrustEnforcementConfigCache } from "./agentshield-trust-config.js";

describe("AgentShield Keyring", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshield-keyring-test-"));
    process.env.AGENTSHIELD_TRUST_ROOT = tempDir;
    clearKeyringCaches();
    clearTrustEnforcementConfigCache();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.AGENTSHIELD_TRUST_ROOT;
    clearKeyringCaches();
    clearTrustEnforcementConfigCache();
  });

  function writeKeyring(publisherId: string, keyring: object) {
    const pubDir = path.join(tempDir, "publishers", publisherId);
    fs.mkdirSync(pubDir, { recursive: true });
    fs.writeFileSync(path.join(pubDir, "keyring.json"), JSON.stringify(keyring, null, 2));
  }

  describe("resolveKeyringPath", () => {
    it("returns null when keyring does not exist", () => {
      const result = resolveKeyringPath("non-existent-publisher");
      expect(result).toBeNull();
    });

    it("returns path when keyring exists", () => {
      const keyring = {
        schema: KEYRING_SCHEMA,
        publisher_id: "test-pub",
        keys: [
          {
            key_id: "k1",
            alg: "ed25519",
            pubkey: "abc123",
            status: "active",
            created_at: "2025-01-01T00:00:00Z",
          },
        ],
      };
      writeKeyring("test-pub", keyring);

      const result = resolveKeyringPath("test-pub");
      expect(result).not.toBeNull();
      expect(result).toContain("test-pub");
    });
  });

  describe("loadKeyring", () => {
    it("returns error when keyring not found", () => {
      const result = loadKeyring("unknown-publisher");
      expect(result.keyring).toBeNull();
      expect(result.verified).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("loads valid keyring", () => {
      const keyring = {
        schema: KEYRING_SCHEMA,
        publisher_id: "test-pub",
        keys: [
          {
            key_id: "k1",
            alg: "ed25519",
            pubkey: "abc123def456",
            status: "active",
            created_at: "2025-01-01T00:00:00Z",
          },
        ],
      };
      writeKeyring("test-pub", keyring);

      const result = loadKeyring("test-pub");
      expect(result.keyring).not.toBeNull();
      expect(result.keyring?.publisher_id).toBe("test-pub");
      expect(result.verified).toBe(true);
    });

    it("marks keyring with wrong schema as not verified", () => {
      const keyring = {
        schema: "wrong.schema.v1",
        publisher_id: "test-pub",
        keys: [],
      };
      writeKeyring("test-pub", keyring);

      const result = loadKeyring("test-pub");
      // Keyring is returned but marked as not verified
      expect(result.keyring).not.toBeNull();
      expect(result.verified).toBe(false);
      expect(result.error).toContain("unexpected schema");
    });

    it("rejects keyring with multiple active keys", () => {
      const keyring = {
        schema: KEYRING_SCHEMA,
        publisher_id: "test-pub",
        keys: [
          {
            key_id: "k1",
            alg: "ed25519",
            pubkey: "key1",
            status: "active",
            created_at: "2025-01-01T00:00:00Z",
          },
          {
            key_id: "k2",
            alg: "ed25519",
            pubkey: "key2",
            status: "active",
            created_at: "2025-01-01T00:00:00Z",
          },
        ],
      };
      writeKeyring("test-pub", keyring);

      const result = loadKeyring("test-pub");
      // It should load but mark as not verified
      expect(result.verified).toBe(false);
      expect(result.error).toContain("expected 1 active key");
    });

    it("caches keyring by mtime", () => {
      const keyring = {
        schema: KEYRING_SCHEMA,
        publisher_id: "test-pub",
        keys: [
          {
            key_id: "k1",
            alg: "ed25519",
            pubkey: "abc",
            status: "active",
            created_at: "2025-01-01T00:00:00Z",
          },
        ],
      };
      writeKeyring("test-pub", keyring);

      const result1 = loadKeyring("test-pub");
      expect(result1.keyring).not.toBeNull();

      // Should use cache
      const result2 = loadKeyring("test-pub");
      expect(result2.keyring).not.toBeNull();
    });
  });

  describe("findKeyByPubkey", () => {
    it("finds key by pubkey hex", () => {
      const keyring = {
        schema: KEYRING_SCHEMA,
        publisher_id: "test",
        keys: [
          { key_id: "k1", alg: "ed25519", pubkey: "abc123", status: "active", created_at: "" },
          { key_id: "k2", alg: "ed25519", pubkey: "def456", status: "retired", created_at: "" },
        ],
      };

      const key = findKeyByPubkey(keyring as KeyringPayload, "def456");
      expect(key).not.toBeNull();
      expect(key?.key_id).toBe("k2");
    });

    it("returns null for unknown pubkey", () => {
      const keyring = {
        schema: KEYRING_SCHEMA,
        publisher_id: "test",
        keys: [
          { key_id: "k1", alg: "ed25519", pubkey: "abc123", status: "active", created_at: "" },
        ],
      };

      const key = findKeyByPubkey(keyring as KeyringPayload, "unknown");
      expect(key).toBeNull();
    });
  });

  describe("getActiveKeys", () => {
    it("returns only active keys", () => {
      const keyring = {
        schema: KEYRING_SCHEMA,
        publisher_id: "test",
        keys: [
          { key_id: "k1", alg: "ed25519", pubkey: "key1", status: "active", created_at: "" },
          { key_id: "k2", alg: "ed25519", pubkey: "key2", status: "retired", created_at: "" },
          { key_id: "k3", alg: "ed25519", pubkey: "key3", status: "revoked", created_at: "" },
        ],
      };

      const active = getActiveKeys(keyring as KeyringPayload);
      expect(active.length).toBe(1);
      expect(active[0]?.key_id).toBe("k1");
    });
  });

  describe("isKeyAuthorized", () => {
    it("returns authorized=true for active key", () => {
      const keyring = {
        schema: KEYRING_SCHEMA,
        publisher_id: "test-pub",
        keys: [
          { key_id: "k1", alg: "ed25519", pubkey: "active-key", status: "active", created_at: "" },
        ],
      };
      writeKeyring("test-pub", keyring);

      const result = isKeyAuthorized("test-pub", "active-key");
      expect(result.authorized).toBe(true);
      expect(result.status).toBe("active");
      expect(result.keyId).toBe("k1");
    });

    it("returns authorized=true for retired key", () => {
      const keyring = {
        schema: KEYRING_SCHEMA,
        publisher_id: "test-pub",
        keys: [
          {
            key_id: "k1",
            alg: "ed25519",
            pubkey: "retired-key",
            status: "retired",
            created_at: "",
          },
          { key_id: "k2", alg: "ed25519", pubkey: "active-key", status: "active", created_at: "" },
        ],
      };
      writeKeyring("test-pub", keyring);

      const result = isKeyAuthorized("test-pub", "retired-key");
      expect(result.authorized).toBe(true);
      expect(result.status).toBe("retired");
    });

    it("returns authorized=false for revoked key", () => {
      const keyring = {
        schema: KEYRING_SCHEMA,
        publisher_id: "test-pub",
        keys: [
          {
            key_id: "k1",
            alg: "ed25519",
            pubkey: "revoked-key",
            status: "revoked",
            created_at: "",
          },
          { key_id: "k2", alg: "ed25519", pubkey: "active-key", status: "active", created_at: "" },
        ],
      };
      writeKeyring("test-pub", keyring);

      const result = isKeyAuthorized("test-pub", "revoked-key");
      expect(result.authorized).toBe(false);
      expect(result.status).toBe("revoked");
    });

    it("returns authorized=false for unknown key", () => {
      const keyring = {
        schema: KEYRING_SCHEMA,
        publisher_id: "test-pub",
        keys: [
          { key_id: "k1", alg: "ed25519", pubkey: "known-key", status: "active", created_at: "" },
        ],
      };
      writeKeyring("test-pub", keyring);

      const result = isKeyAuthorized("test-pub", "unknown-key");
      expect(result.authorized).toBe(false);
      expect(result.status).toBeNull();
    });
  });
});
