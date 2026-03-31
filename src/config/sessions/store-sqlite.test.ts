import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  capSessionEntriesSqlite,
  closeSessionDatabase,
  deleteSessionEntrySqlite,
  getSessionCountSqlite,
  getSessionEntrySqlite,
  loadSessionStoreSqlite,
  migrateJsonToSqlite,
  pruneSessionsOlderThanSqlite,
  resolveSqlitePathFromJsonPath,
  saveSessionStoreSqlite,
  sqliteStoreExists,
  upsertSessionEntrySqlite,
} from "./store-sqlite.js";
import type { SessionEntry } from "./types.js";

describe("store-sqlite", () => {
  const testDir = path.join("/tmp", "openclaw-sqlite-test-" + process.pid);
  const sqlitePath = path.join(testDir, "sessions.sqlite");
  const jsonPath = path.join(testDir, "sessions.json");

  beforeEach(() => {
    closeSessionDatabase();
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    closeSessionDatabase();
    rmSync(testDir, { recursive: true, force: true });
  });

  const createTestEntry = (sessionKey: string, overrides: Partial<SessionEntry> = {}): SessionEntry => ({
    sessionId: `sid-${sessionKey}`,
    updatedAt: Date.now(),
    ...overrides,
  });

  describe("resolveSqlitePathFromJsonPath", () => {
    it("converts .json path to .sqlite", () => {
      const input = path.join(path.sep, "path", "to", "sessions.json");
      const expected = path.join(path.sep, "path", "to", "sessions.sqlite");
      expect(resolveSqlitePathFromJsonPath(input)).toBe(expected);
    });

    it("handles paths without .json extension", () => {
      const input = path.join(path.sep, "path", "to", "store");
      const expected = path.join(path.sep, "path", "to", "store.sqlite");
      expect(resolveSqlitePathFromJsonPath(input)).toBe(expected);
    });
  });

  describe("loadSessionStoreSqlite", () => {
    it("returns empty store when database does not exist", () => {
      const store = loadSessionStoreSqlite(sqlitePath);
      expect(store).toEqual({});
    });

    it("loads stored sessions", () => {
      const entry = createTestEntry("test-key");
      upsertSessionEntrySqlite(sqlitePath, "test-key", entry);

      const store = loadSessionStoreSqlite(sqlitePath);
      expect(Object.keys(store)).toHaveLength(1);
      expect(store["test-key"]).toBeDefined();
      expect(store["test-key"]?.sessionId).toBe("sid-test-key");
    });
  });

  describe("saveSessionStoreSqlite", () => {
    it("saves all sessions atomically", () => {
      const store: Record<string, SessionEntry> = {
        "key1": createTestEntry("key1"),
        "key2": createTestEntry("key2"),
        "key3": createTestEntry("key3"),
      };

      saveSessionStoreSqlite(sqlitePath, store);

      expect(getSessionCountSqlite(sqlitePath)).toBe(3);
      const loaded = loadSessionStoreSqlite(sqlitePath);
      expect(Object.keys(loaded)).toHaveLength(3);
    });

    it("replaces all existing entries", () => {
      upsertSessionEntrySqlite(sqlitePath, "old-key", createTestEntry("old-key"));
      expect(getSessionCountSqlite(sqlitePath)).toBe(1);

      const newStore: Record<string, SessionEntry> = {
        "new-key": createTestEntry("new-key"),
      };
      saveSessionStoreSqlite(sqlitePath, newStore);

      expect(getSessionCountSqlite(sqlitePath)).toBe(1);
      expect(getSessionEntrySqlite(sqlitePath, "old-key")).toBeUndefined();
      expect(getSessionEntrySqlite(sqlitePath, "new-key")).toBeDefined();
    });
  });

  describe("upsertSessionEntrySqlite", () => {
    it("inserts new entry", () => {
      const entry = createTestEntry("new-key", { label: "Test Label" });
      upsertSessionEntrySqlite(sqlitePath, "new-key", entry);

      const loaded = getSessionEntrySqlite(sqlitePath, "new-key");
      expect(loaded?.sessionId).toBe("sid-new-key");
      expect(loaded?.label).toBe("Test Label");
    });

    it("updates existing entry", () => {
      const entry1 = createTestEntry("key", { label: "First" });
      upsertSessionEntrySqlite(sqlitePath, "key", entry1);

      const entry2 = createTestEntry("key", { label: "Second" });
      upsertSessionEntrySqlite(sqlitePath, "key", entry2);

      const loaded = getSessionEntrySqlite(sqlitePath, "key");
      expect(loaded?.label).toBe("Second");
      expect(getSessionCountSqlite(sqlitePath)).toBe(1);
    });
  });

  describe("deleteSessionEntrySqlite", () => {
    it("deletes existing entry", () => {
      upsertSessionEntrySqlite(sqlitePath, "key", createTestEntry("key"));
      expect(getSessionCountSqlite(sqlitePath)).toBe(1);

      deleteSessionEntrySqlite(sqlitePath, "key");
      expect(getSessionCountSqlite(sqlitePath)).toBe(0);
    });

    it("handles non-existent key gracefully", () => {
      expect(() => deleteSessionEntrySqlite(sqlitePath, "nonexistent")).not.toThrow();
    });
  });

  describe("pruneSessionsOlderThanSqlite", () => {
    it("removes old sessions", () => {
      const oldTime = Date.now() - 100_000;
      const newTime = Date.now();

      upsertSessionEntrySqlite(sqlitePath, "old", createTestEntry("old", { updatedAt: oldTime }));
      upsertSessionEntrySqlite(sqlitePath, "new", createTestEntry("new", { updatedAt: newTime }));

      const pruned = pruneSessionsOlderThanSqlite(sqlitePath, 50_000);
      expect(pruned).toBe(1);
      expect(getSessionCountSqlite(sqlitePath)).toBe(1);
      expect(getSessionEntrySqlite(sqlitePath, "new")).toBeDefined();
      expect(getSessionEntrySqlite(sqlitePath, "old")).toBeUndefined();
    });
  });

  describe("capSessionEntriesSqlite", () => {
    it("removes oldest entries exceeding cap", () => {
      const now = Date.now();
      upsertSessionEntrySqlite(sqlitePath, "oldest", createTestEntry("oldest", { updatedAt: now - 3000 }));
      upsertSessionEntrySqlite(sqlitePath, "middle", createTestEntry("middle", { updatedAt: now - 2000 }));
      upsertSessionEntrySqlite(sqlitePath, "newest", createTestEntry("newest", { updatedAt: now - 1000 }));

      const capped = capSessionEntriesSqlite(sqlitePath, 2);
      expect(capped).toBe(1);
      expect(getSessionCountSqlite(sqlitePath)).toBe(2);
      expect(getSessionEntrySqlite(sqlitePath, "oldest")).toBeUndefined();
      expect(getSessionEntrySqlite(sqlitePath, "middle")).toBeDefined();
      expect(getSessionEntrySqlite(sqlitePath, "newest")).toBeDefined();
    });

    it("does nothing when under cap", () => {
      upsertSessionEntrySqlite(sqlitePath, "key", createTestEntry("key"));

      const capped = capSessionEntriesSqlite(sqlitePath, 10);
      expect(capped).toBe(0);
      expect(getSessionCountSqlite(sqlitePath)).toBe(1);
    });
  });

  describe("sqliteStoreExists", () => {
    it("returns false when file does not exist", () => {
      expect(sqliteStoreExists(sqlitePath)).toBe(false);
    });

    it("returns true after store creation", () => {
      upsertSessionEntrySqlite(sqlitePath, "key", createTestEntry("key"));
      expect(sqliteStoreExists(sqlitePath)).toBe(true);
    });
  });

  describe("migrateJsonToSqlite", () => {
    it("migrates sessions from JSON file", () => {
      const jsonStore: Record<string, SessionEntry> = {
        "key1": createTestEntry("key1"),
        "key2": createTestEntry("key2"),
      };
      writeFileSync(jsonPath, JSON.stringify(jsonStore));

      const migrated = migrateJsonToSqlite(jsonPath, sqlitePath);
      expect(migrated).toBe(2);
      expect(getSessionCountSqlite(sqlitePath)).toBe(2);
    });

    it("returns 0 when JSON file does not exist", () => {
      const migrated = migrateJsonToSqlite(jsonPath, sqlitePath);
      expect(migrated).toBe(0);
    });

    it("returns 0 for empty JSON file", () => {
      writeFileSync(jsonPath, "");
      const migrated = migrateJsonToSqlite(jsonPath, sqlitePath);
      expect(migrated).toBe(0);
    });

    it("returns 0 for empty object", () => {
      writeFileSync(jsonPath, "{}");
      const migrated = migrateJsonToSqlite(jsonPath, sqlitePath);
      expect(migrated).toBe(0);
    });
  });

  describe("session entry fields", () => {
    it("preserves all indexed fields", () => {
      const entry: SessionEntry = {
        sessionId: "test-sid",
        updatedAt: Date.now(),
        channel: "telegram",
        lastChannel: "telegram",
        lastTo: "+1234567890",
        lastAccountId: "account-123",
        lastThreadId: "thread-456",
        label: "Test Session",
        displayName: "Test User",
        status: "running",
        model: "sonnet-4.6",
        modelProvider: "anthropic",
        totalTokens: 1000,
        inputTokens: 500,
        outputTokens: 500,
      };

      upsertSessionEntrySqlite(sqlitePath, "full-key", entry);
      const loaded = getSessionEntrySqlite(sqlitePath, "full-key");

      expect(loaded?.sessionId).toBe("test-sid");
      expect(loaded?.channel).toBe("telegram");
      expect(loaded?.lastChannel).toBe("telegram");
      expect(loaded?.lastTo).toBe("+1234567890");
      expect(loaded?.lastAccountId).toBe("account-123");
      expect(loaded?.lastThreadId).toBe("thread-456");
      expect(loaded?.label).toBe("Test Session");
      expect(loaded?.displayName).toBe("Test User");
      expect(loaded?.status).toBe("running");
      expect(loaded?.model).toBe("sonnet-4.6");
      expect(loaded?.modelProvider).toBe("anthropic");
      expect(loaded?.totalTokens).toBe(1000);
      expect(loaded?.inputTokens).toBe(500);
      expect(loaded?.outputTokens).toBe(500);
    });

    it("preserves complex fields via JSON blob", () => {
      const entry: SessionEntry = {
        sessionId: "test-sid",
        updatedAt: Date.now(),
        origin: {
          label: "Test Origin",
          provider: "telegram",
          from: "+1234567890",
        },
        deliveryContext: {
          channel: "telegram",
          to: "+0987654321",
        },
        cliSessionBindings: {
          "binding-1": { sessionId: "cli-sid-1" },
        },
      };

      upsertSessionEntrySqlite(sqlitePath, "complex-key", entry);
      const loaded = getSessionEntrySqlite(sqlitePath, "complex-key");

      expect(loaded?.origin?.label).toBe("Test Origin");
      expect(loaded?.origin?.provider).toBe("telegram");
      expect(loaded?.deliveryContext?.to).toBe("+0987654321");
      expect(loaded?.cliSessionBindings?.["binding-1"]?.sessionId).toBe("cli-sid-1");
    });
  });
});
