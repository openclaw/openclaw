/**
 * Tests for agent-api-keys-sqlite.ts (Paperclip sync)
 *
 * Covers:
 * - createAgentApiKey returns rawKey and stores hash
 * - verifyAgentApiKey returns agent info for valid key
 * - verifyAgentApiKey returns null for invalid key
 * - revokeAgentApiKey makes verification fail
 * - listAgentApiKeys returns keys without hashes
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../infra/state-db/schema.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

type TestDb = ReturnType<typeof requireNodeSqlite>["DatabaseSync"]["prototype"];
let testDb: TestDb;

vi.mock("../infra/state-db/connection.js", () => ({ getStateDb: () => testDb }));
vi.mock("../infra/state-db/index.js", () => ({ getStateDb: () => testDb }));

import {
  createAgentApiKey,
  listAgentApiKeys,
  revokeAgentApiKey,
  verifyAgentApiKey,
} from "./agent-api-keys-sqlite.js";
import { createWorkspace } from "./workspace-store-sqlite.js";

describe("agent-api-keys-sqlite", () => {
  beforeEach(() => {
    const { DatabaseSync } = requireNodeSqlite();
    testDb = new DatabaseSync(":memory:");
    testDb.exec("PRAGMA journal_mode = WAL");
    testDb.exec("PRAGMA foreign_keys = ON");
    runMigrations(testDb);
  });

  afterEach(() => {
    try {
      testDb.close();
    } catch {
      // ignore
    }
  });

  // ── createAgentApiKey ─────────────────────────────────────────────

  describe("createAgentApiKey", () => {
    it("returns rawKey, id, agentId, name, keyPrefix, and createdAt", () => {
      const result = createAgentApiKey({ agentId: "agent-neo", name: "ci-key" });

      expect(result.id).toBeTruthy();
      expect(result.agentId).toBe("agent-neo");
      expect(result.name).toBe("ci-key");
      expect(result.rawKey).toBeTruthy();
      expect(result.keyPrefix).toBe(result.rawKey.slice(0, 8));
      expect(typeof result.createdAt).toBe("number");
    });

    it("rawKey is a 64-character hex string (32 random bytes)", () => {
      const { rawKey } = createAgentApiKey({ agentId: "agent-a", name: "test-key" });
      expect(rawKey).toHaveLength(64);
      expect(/^[0-9a-f]+$/.test(rawKey)).toBe(true);
    });

    it("does NOT store rawKey in the database — only the hash", () => {
      const { rawKey, id } = createAgentApiKey({ agentId: "agent-b", name: "secure" });

      // Query the raw DB row
      const row = testDb.prepare("SELECT * FROM op1_agent_api_keys WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;

      expect(row).toBeDefined();
      // raw key must not appear anywhere in the stored record
      expect(JSON.stringify(row)).not.toContain(rawKey);
      // key_hash must be present and non-empty
      expect(typeof row!.key_hash).toBe("string");
      expect((row!.key_hash as string).length).toBeGreaterThan(0);
    });

    it("each call produces a unique rawKey", () => {
      const k1 = createAgentApiKey({ agentId: "agent-c", name: "key-1" });
      const k2 = createAgentApiKey({ agentId: "agent-c", name: "key-2" });
      expect(k1.rawKey).not.toBe(k2.rawKey);
    });

    it("uses default workspaceId when not provided", () => {
      const { id } = createAgentApiKey({ agentId: "agent-d", name: "default-ws-key" });
      const row = testDb
        .prepare("SELECT workspace_id FROM op1_agent_api_keys WHERE id = ?")
        .get(id) as { workspace_id: string } | undefined;
      expect(row?.workspace_id).toBe("default");
    });

    it("stores the provided workspaceId", () => {
      const ws = createWorkspace({ name: "API Key WS" });
      const { id } = createAgentApiKey({
        agentId: "agent-e",
        name: "ws-key",
        workspaceId: ws.id,
      });
      const row = testDb
        .prepare("SELECT workspace_id FROM op1_agent_api_keys WHERE id = ?")
        .get(id) as { workspace_id: string } | undefined;
      expect(row?.workspace_id).toBe(ws.id);
    });
  });

  // ── verifyAgentApiKey ─────────────────────────────────────────────

  describe("verifyAgentApiKey", () => {
    it("returns agentId, workspaceId, and name for a valid key", () => {
      const ws = createWorkspace({ name: "Verify WS" });
      const { rawKey } = createAgentApiKey({
        agentId: "agent-verify",
        name: "verify-key",
        workspaceId: ws.id,
      });

      const result = verifyAgentApiKey(rawKey);
      expect(result).not.toBeNull();
      expect(result!.agentId).toBe("agent-verify");
      expect(result!.workspaceId).toBe(ws.id);
      expect(result!.name).toBe("verify-key");
    });

    it("updates last_used_at on successful verification", () => {
      const { rawKey, id } = createAgentApiKey({ agentId: "agent-lu", name: "lu-key" });

      // Before verification last_used_at should be null
      const before = testDb
        .prepare("SELECT last_used_at FROM op1_agent_api_keys WHERE id = ?")
        .get(id) as { last_used_at: number | null };
      expect(before.last_used_at).toBeNull();

      verifyAgentApiKey(rawKey);

      const after = testDb
        .prepare("SELECT last_used_at FROM op1_agent_api_keys WHERE id = ?")
        .get(id) as { last_used_at: number | null };
      expect(after.last_used_at).not.toBeNull();
    });

    it("returns null for a completely unknown key", () => {
      expect(verifyAgentApiKey("deadbeef".repeat(8))).toBeNull();
    });

    it("returns null for an empty string", () => {
      expect(verifyAgentApiKey("")).toBeNull();
    });

    it("returns null for a key that belongs to a different agent (wrong hash)", () => {
      createAgentApiKey({ agentId: "agent-other", name: "other-key" });
      // Use a plausible but incorrect key
      expect(verifyAgentApiKey("a".repeat(64))).toBeNull();
    });
  });

  // ── revokeAgentApiKey ─────────────────────────────────────────────

  describe("revokeAgentApiKey", () => {
    it("makes verifyAgentApiKey return null after revocation", () => {
      const { rawKey, id } = createAgentApiKey({ agentId: "agent-rev", name: "rev-key" });

      // Verify works before revocation
      expect(verifyAgentApiKey(rawKey)).not.toBeNull();

      revokeAgentApiKey(id);

      // Should fail after revocation
      expect(verifyAgentApiKey(rawKey)).toBeNull();
    });

    it("sets revoked_at in the database", () => {
      const before = Math.floor(Date.now() / 1000) - 1;
      const { id } = createAgentApiKey({ agentId: "agent-rev2", name: "rev-key2" });
      revokeAgentApiKey(id);

      const row = testDb
        .prepare("SELECT revoked_at FROM op1_agent_api_keys WHERE id = ?")
        .get(id) as { revoked_at: number | null } | undefined;

      expect(row?.revoked_at).not.toBeNull();
      expect(row!.revoked_at!).toBeGreaterThan(before);
    });

    it("does not affect other keys for the same agent", () => {
      const k1 = createAgentApiKey({ agentId: "agent-multi", name: "key-1" });
      const k2 = createAgentApiKey({ agentId: "agent-multi", name: "key-2" });

      revokeAgentApiKey(k1.id);

      expect(verifyAgentApiKey(k1.rawKey)).toBeNull();
      expect(verifyAgentApiKey(k2.rawKey)).not.toBeNull();
    });
  });

  // ── listAgentApiKeys ──────────────────────────────────────────────

  describe("listAgentApiKeys", () => {
    it("returns keys without key_hash field", () => {
      createAgentApiKey({ agentId: "agent-list", name: "list-key" });
      const keys = listAgentApiKeys("agent-list");
      expect(keys).toHaveLength(1);
      // AgentApiKey type does not include keyHash
      expect("keyHash" in keys[0]).toBe(false);
      expect("key_hash" in keys[0]).toBe(false);
    });

    it("returns all keys for the specified agent", () => {
      createAgentApiKey({ agentId: "agent-two", name: "key-a" });
      createAgentApiKey({ agentId: "agent-two", name: "key-b" });
      createAgentApiKey({ agentId: "agent-other", name: "key-c" });

      const keys = listAgentApiKeys("agent-two");
      expect(keys).toHaveLength(2);
      expect(keys.every((k) => k.agentId === "agent-two")).toBe(true);
    });

    it("returns all keys across all agents when agentId is omitted", () => {
      createAgentApiKey({ agentId: "agent-p", name: "key-p" });
      createAgentApiKey({ agentId: "agent-q", name: "key-q" });

      const all = listAgentApiKeys();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it("returns an empty array when agent has no keys", () => {
      expect(listAgentApiKeys("no-keys-agent")).toHaveLength(0);
    });

    it("includes revoked keys in the list (listing is not filtered by revocation)", () => {
      const { id } = createAgentApiKey({ agentId: "agent-rev-list", name: "rev-listed" });
      revokeAgentApiKey(id);

      const keys = listAgentApiKeys("agent-rev-list");
      expect(keys).toHaveLength(1);
      expect(keys[0].revokedAt).not.toBeNull();
    });

    it("returns keys with correct metadata fields", () => {
      const ws = createWorkspace({ name: "Meta WS" });
      createAgentApiKey({ agentId: "agent-meta", name: "meta-key", workspaceId: ws.id });
      const keys = listAgentApiKeys("agent-meta");
      expect(keys).toHaveLength(1);
      const k = keys[0];
      expect(k.id).toBeTruthy();
      expect(k.agentId).toBe("agent-meta");
      expect(k.workspaceId).toBe(ws.id);
      expect(k.name).toBe("meta-key");
      expect(k.keyPrefix).toHaveLength(8);
      expect(typeof k.createdAt).toBe("number");
    });
  });
});
