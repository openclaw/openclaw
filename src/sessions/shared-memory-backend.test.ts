import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionMemoryEntry,
  GlobalKnowledgeEntry,
  SessionState,
} from "./parallel-session-manager.js";

// Build a minimal in-memory mock that mirrors the node:sqlite DatabaseSync API.
// This lets unit tests run on any Node version without needing the real native module.
function createMockDatabaseSync() {
  const tables = new Map<string, Array<Record<string, unknown>>>();
  let autoId = 0;

  function getTable(name: string) {
    if (!tables.has(name)) {
      tables.set(name, []);
    }
    return tables.get(name)!;
  }

  const db = {
    exec: vi.fn((sql: string) => {
      // Track table creation so getTable can find them
      const match = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
      if (match) {
        getTable(match[1]);
      }
    }),
    prepare: vi.fn((sql: string) => {
      return {
        run: vi.fn((...params: unknown[]) => {
          autoId++;
          // Detect INSERT and store row for later retrieval
          const insertMatch = sql.match(/INSERT.*INTO\s+(\w+)/i);
          if (insertMatch) {
            const table = getTable(insertMatch[1]);
            table.push({ id: autoId, params });
          }
          return { changes: 1, lastInsertRowid: autoId };
        }),
        get: vi.fn((..._params: unknown[]) => {
          // Return a sensible default for COUNT queries
          if (sql.includes("COUNT(*)")) {
            return { c: 0 };
          }
          return undefined;
        }),
        all: vi.fn((..._params: unknown[]) => {
          return [];
        }),
      };
    }),
    close: vi.fn(),
  };

  return db;
}

// Mock the sqlite import so SharedMemoryBackend uses our fake DatabaseSync
let mockDb: ReturnType<typeof createMockDatabaseSync>;

vi.mock("../memory/sqlite.js", () => ({
  requireNodeSqlite: () => ({
    DatabaseSync: class {
      constructor() {
        return mockDb;
      }
    },
  }),
}));

// Import after mock registration
const { SharedMemoryBackend } = await import("./shared-memory-backend.js");

describe("SharedMemoryBackend", () => {
  let tmpDir: string;
  let backend: InstanceType<typeof SharedMemoryBackend>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "smb-test-"));
    mockDb = createMockDatabaseSync();
    backend = new SharedMemoryBackend({
      dbPath: path.join(tmpDir, "test-shared-memory.db"),
      enableWAL: true,
    });
    await backend.initialize();
  });

  afterEach(async () => {
    await backend.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates schema tables on initialize", async () => {
    // exec is called for each table + indexes + PRAGMA
    expect(mockDb.exec).toHaveBeenCalled();
    const calls = mockDb.exec.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((s: string) => s.includes("channel_memory"))).toBe(true);
    expect(calls.some((s: string) => s.includes("global_knowledge"))).toBe(true);
    expect(calls.some((s: string) => s.includes("session_state"))).toBe(true);
    expect(calls.some((s: string) => s.includes("work_items"))).toBe(true);
    expect(calls.some((s: string) => s.includes("person_context"))).toBe(true);
  });

  it("drops orphaned action_items table on initialize", async () => {
    const calls = mockDb.exec.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((s: string) => s.includes("DROP TABLE IF EXISTS action_items"))).toBe(true);
  });

  it("enables WAL mode by default", async () => {
    const calls = mockDb.exec.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((s: string) => s.includes("journal_mode = WAL"))).toBe(true);
  });

  it("skips duplicate initialize", async () => {
    const callCount = mockDb.exec.mock.calls.length;
    await backend.initialize();
    // Should not call exec again
    expect(mockDb.exec.mock.calls.length).toBe(callCount);
  });

  it("saveChannelMemory calls prepare/run with correct params", async () => {
    const now = Date.now();
    const entry: Omit<SessionMemoryEntry, "id"> = {
      sessionKey: "agent:main:parallel:discord",
      channelId: "discord",
      memoryType: "fact",
      content: "user likes TypeScript",
      importance: 7,
      createdAt: now,
      promotedToGlobal: false,
    };
    const id = await backend.saveChannelMemory(entry);
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO channel_memory"),
    );
    // Verify the run() call received the actual field values
    const prepareCalls = mockDb.prepare.mock.results;
    const lastStmt = prepareCalls[prepareCalls.length - 1].value;
    const runArgs = lastStmt.run.mock.calls[0];
    expect(runArgs).toContain("agent:main:parallel:discord");
    expect(runArgs).toContain("discord");
    expect(runArgs).toContain("fact");
    expect(runArgs).toContain("user likes TypeScript");
    expect(runArgs).toContain(7);
  });

  it("getChannelMemories calls prepare/all", async () => {
    const results = await backend.getChannelMemories({ channelId: "discord" });
    expect(Array.isArray(results)).toBe(true);
    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining("SELECT * FROM channel_memory"),
    );
  });

  it("saveGlobalKnowledge calls prepare/run and returns id", async () => {
    const entry: Omit<GlobalKnowledgeEntry, "id"> = {
      category: "decision",
      content: "always use vitest",
      sourceChannel: "discord",
      sourceSessionKey: "agent:main:parallel:discord",
      confidence: 0.9,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const id = await backend.saveGlobalKnowledge(entry);
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
  });

  it("getGlobalKnowledge calls prepare/all", async () => {
    const results = await backend.getGlobalKnowledge({ category: "fact" });
    expect(Array.isArray(results)).toBe(true);
  });

  it("searchMemories queries both tables by default", async () => {
    await backend.searchMemories("test");
    // Should have called prepare for both channel_memory and global_knowledge
    const prepareCalls = mockDb.prepare.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(prepareCalls.some((s: string) => s.includes("channel_memory"))).toBe(true);
    expect(prepareCalls.some((s: string) => s.includes("global_knowledge"))).toBe(true);
  });

  it("searchMemories respects scope=channel", async () => {
    // Reset calls after init
    mockDb.prepare.mockClear();
    await backend.searchMemories("test", { scope: "channel" });
    const prepareCalls = mockDb.prepare.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(prepareCalls.some((s: string) => s.includes("channel_memory"))).toBe(true);
    expect(prepareCalls.some((s: string) => s.includes("global_knowledge"))).toBe(false);
  });

  it("saveSessionState persists session for hibernation", async () => {
    const session: SessionState = {
      sessionKey: "agent:main:parallel:discord",
      channelId: "discord",
      status: "hibernated",
      messageCount: 42,
      createdAt: Date.now() - 10_000,
      lastActivityAt: Date.now(),
    };
    await backend.saveSessionState(session, { foo: "bar" });
    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining("INSERT OR REPLACE INTO session_state"),
    );
  });

  it("loadSessionState returns null for missing key", async () => {
    const result = await backend.loadSessionState("nonexistent");
    expect(result).toBeNull();
  });

  it("deleteSessionState removes the entry", async () => {
    await backend.deleteSessionState("agent:main:parallel:discord");
    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM session_state"),
    );
  });

  it("getStats returns counts", async () => {
    const stats = await backend.getStats();
    expect(stats).toEqual({
      channelMemoryCount: 0,
      globalKnowledgeCount: 0,
      workItemsActive: 0,
      personCount: 0,
    });
  });

  it("cleanupExpired runs DELETE query", async () => {
    const count = await backend.cleanupExpired();
    expect(typeof count).toBe("number");
    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM channel_memory"),
    );
  });

  it("close is idempotent", async () => {
    await backend.close();
    await backend.close(); // Should not throw
    expect(mockDb.close).toHaveBeenCalledTimes(1);
  });

  it("throws if not initialized", async () => {
    const uninit = new SharedMemoryBackend({ dbPath: "/tmp/nope.db" });
    await expect(
      uninit.saveChannelMemory({
        sessionKey: "x",
        channelId: "x",
        memoryType: "fact",
        content: "x",
        importance: 5,
        createdAt: Date.now(),
        promotedToGlobal: false,
      }),
    ).rejects.toThrow("not initialized");
  });

  // ── Work Item CRUD ──

  describe("saveWorkItem", () => {
    it("inserts and returns id", async () => {
      const id = await backend.saveWorkItem({
        sessionKey: "agent:main:parallel:discord",
        channelId: "discord",
        description: "Research competitors",
        payload: { url: "https://example.com" },
        status: "ready",
        priority: 7,
        createdAt: Date.now(),
        attempts: 0,
        maxAttempts: 3,
      });
      expect(typeof id).toBe("number");
      expect(id).toBeGreaterThan(0);
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO work_items"),
      );
    });

    it("serializes payload as JSON in run() params", async () => {
      const payload = { key: "value", nested: { a: 1 } };
      await backend.saveWorkItem({
        sessionKey: "s",
        channelId: "c",
        description: "d",
        payload,
        status: "ready",
        priority: 5,
        createdAt: Date.now(),
        attempts: 0,
        maxAttempts: 3,
      });
      // Verify the run() params contain the JSON-serialized payload
      const prepareCalls = mockDb.prepare.mock.results;
      const lastStmt = prepareCalls[prepareCalls.length - 1].value;
      const runArgs = lastStmt.run.mock.calls[0];
      expect(runArgs).toContain(JSON.stringify(payload));
    });
  });

  describe("getWorkItems", () => {
    it("filters by sessionKey", async () => {
      await backend.getWorkItems({ sessionKey: "agent:main:parallel:discord" });
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM work_items"),
      );
    });

    it("filters by statuses", async () => {
      await backend.getWorkItems({ statuses: ["ready", "executing"] });
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM work_items"),
      );
    });
  });

  describe("claimReadyWork", () => {
    it("uses BEGIN IMMEDIATE transaction", async () => {
      await backend.claimReadyWork(1);
      expect(mockDb.exec).toHaveBeenCalledWith("BEGIN IMMEDIATE");
      expect(mockDb.exec).toHaveBeenCalledWith("COMMIT");
    });

    it("rolls back on error", async () => {
      // Make the SELECT throw
      mockDb.prepare.mockImplementationOnce(() => {
        throw new Error("SQL error");
      });
      await expect(backend.claimReadyWork(1)).rejects.toThrow("SQL error");
      expect(mockDb.exec).toHaveBeenCalledWith("ROLLBACK");
    });
  });

  describe("transitionWork", () => {
    it("updates status", async () => {
      await backend.transitionWork(1, "completed", { resultSummary: "Done" });
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("UPDATE work_items SET"));
    });

    it("sets started_at on executing", async () => {
      await backend.transitionWork(1, "executing");
      const prepareCalls = mockDb.prepare.mock.calls.map((c: unknown[]) => String(c[0]));
      const updateCall = prepareCalls.find((s: string) => s.includes("UPDATE work_items"));
      expect(updateCall).toContain("started_at");
    });

    it("sets completed_at on completed", async () => {
      await backend.transitionWork(1, "completed");
      const prepareCalls = mockDb.prepare.mock.calls.map((c: unknown[]) => String(c[0]));
      const updateCall = prepareCalls.find((s: string) => s.includes("UPDATE work_items"));
      expect(updateCall).toContain("completed_at");
    });

    it("sets completed_at on failed", async () => {
      await backend.transitionWork(1, "failed", { resultSummary: "Error" });
      const prepareCalls = mockDb.prepare.mock.calls.map((c: unknown[]) => String(c[0]));
      const updateCall = prepareCalls.find((s: string) => s.includes("UPDATE work_items"));
      expect(updateCall).toContain("completed_at");
    });

    it("updates progressPct", async () => {
      await backend.transitionWork(1, "executing", { progressPct: 50 });
      const prepareCalls = mockDb.prepare.mock.calls.map((c: unknown[]) => String(c[0]));
      const updateCall = prepareCalls.find((s: string) => s.includes("UPDATE work_items"));
      expect(updateCall).toContain("progress_pct");
    });
  });

  describe("cancelWork", () => {
    it("calls UPDATE with correct status filter and guards", async () => {
      await backend.cancelWork(42);
      const prepareCalls = mockDb.prepare.mock.calls.map((c: unknown[]) => String(c[0]));
      const cancelQuery = prepareCalls.find((s: string) => s.includes("status = 'cancelled'"));
      expect(cancelQuery).toBeDefined();
      // Must only cancel items that are still scheduled or ready (not executing/completed)
      expect(cancelQuery).toContain("scheduled");
      expect(cancelQuery).toContain("ready");
    });
  });
});
