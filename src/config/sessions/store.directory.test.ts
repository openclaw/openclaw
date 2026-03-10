import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listAgentSessionDirs } from "../../commands/cleanup-utils.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  migrateSessionStoreToDirectory,
  readSessionUpdatedAt,
  resolveSessionStoreDir,
  sanitizeSessionKey,
  desanitizeSessionKey,
  saveSessionStore,
  updateSessionStore,
  updateSessionStoreEntry,
} from "./store.js";
import type { SessionEntry } from "./types.js";

// Keep tests deterministic: never read a real openclaw.json.
vi.mock("../config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));

let fixtureRoot = "";
let fixtureCount = 0;

function makeEntry(updatedAt: number, extra?: Partial<SessionEntry>): SessionEntry {
  return { sessionId: crypto.randomUUID(), updatedAt, ...extra };
}

async function createCaseDir(prefix: string): Promise<string> {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dirstore-suite-"));
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

afterEach(() => {
  clearSessionStoreCacheForTest();
});

// ============================================================================
// Key sanitization
// ============================================================================

describe("sanitizeSessionKey / desanitizeSessionKey", () => {
  it("replaces colons with %3A", () => {
    expect(sanitizeSessionKey("agent:main:telegram:direct:james")).toBe(
      "agent%3Amain%3Atelegram%3Adirect%3Ajames",
    );
  });

  it("round-trips correctly", () => {
    const key = "agent:main:telegram:direct:james";
    expect(desanitizeSessionKey(sanitizeSessionKey(key))).toBe(key);
  });

  it("handles keys without colons", () => {
    expect(sanitizeSessionKey("simple-key")).toBe("simple-key");
    expect(desanitizeSessionKey("simple-key")).toBe("simple-key");
  });

  it("handles keys with percent signs", () => {
    const key = "agent:main:100%done";
    const sanitized = sanitizeSessionKey(key);
    expect(sanitized).toBe("agent%3Amain%3A100%25done");
    expect(desanitizeSessionKey(sanitized)).toBe(key);
  });

  it("handles keys with hyphens (no ambiguity)", () => {
    const key = "agent:my-agent:telegram:direct:user";
    const sanitized = sanitizeSessionKey(key);
    expect(desanitizeSessionKey(sanitized)).toBe(key);
  });

  it("encodes forward slashes to prevent path traversal", () => {
    const key = "agent:main:some/nested/path";
    const sanitized = sanitizeSessionKey(key);
    expect(sanitized).not.toContain("/");
    expect(desanitizeSessionKey(sanitized)).toBe(key);
  });

  it("encodes backslashes to prevent path traversal", () => {
    const key = "agent:main:some\\nested\\path";
    const sanitized = sanitizeSessionKey(key);
    expect(sanitized).not.toContain("\\");
    expect(desanitizeSessionKey(sanitized)).toBe(key);
  });

  it("round-trips keys with all special characters", () => {
    const key = "agent:main:100%done/with\\work";
    expect(desanitizeSessionKey(sanitizeSessionKey(key))).toBe(key);
  });
});

// ============================================================================
// resolveSessionStoreDir
// ============================================================================

describe("resolveSessionStoreDir", () => {
  it("returns sessions.d in the same directory as storePath", () => {
    const storePath = path.join("/tmp", "openclaw", "agents", "main", "sessions", "sessions.json");
    expect(resolveSessionStoreDir(storePath)).toBe(
      path.join("/tmp", "openclaw", "agents", "main", "sessions", "sessions.d"),
    );
  });
});

// ============================================================================
// Migration: JSON -> directory
// ============================================================================

describe("migration: JSON to directory", () => {
  let testDir: string;
  let storePath: string;

  beforeEach(async () => {
    testDir = await createCaseDir("migration");
    storePath = path.join(testDir, "sessions.json");
  });

  it("migrates legacy sessions.json via migrateSessionStoreToDirectory", async () => {
    const now = Date.now();
    const initialStore: Record<string, SessionEntry> = {
      "agent:main:test": makeEntry(now, { modelOverride: "test-model" }),
      "agent:main:other": makeEntry(now - 1000),
    };
    await fs.writeFile(storePath, JSON.stringify(initialStore, null, 2), "utf-8");

    const migrated = await migrateSessionStoreToDirectory(storePath);
    expect(migrated).toBe(true);

    // Directory store should exist
    const storeDir = resolveSessionStoreDir(storePath);
    const stat = await fs.stat(storeDir);
    expect(stat.isDirectory()).toBe(true);

    // Original JSON should be backed up
    const dirEntries = await fs.readdir(testDir);
    const backupFiles = dirEntries.filter((f) => f.includes(".bak."));
    expect(backupFiles.length).toBe(1);

    // Load should read from directory
    const loaded = loadSessionStore(storePath);
    expect(loaded["agent:main:test"]?.modelOverride).toBe("test-model");
    expect(Object.keys(loaded)).toHaveLength(2);
  });

  it("migration is idempotent", async () => {
    const now = Date.now();
    const initialStore: Record<string, SessionEntry> = {
      "agent:main:test": makeEntry(now),
    };
    await fs.writeFile(storePath, JSON.stringify(initialStore, null, 2), "utf-8");

    const first = await migrateSessionStoreToDirectory(storePath);
    expect(first).toBe(true);
    const second = await migrateSessionStoreToDirectory(storePath);
    expect(second).toBe(false);
  });

  it("preserves data integrity during migration", async () => {
    const now = Date.now();
    const keys = Array.from({ length: 50 }, (_, i) => `agent:main:session-${i}`);
    const initialStore: Record<string, SessionEntry> = {};
    for (const key of keys) {
      initialStore[key] = makeEntry(now - Math.random() * 10000);
    }
    await fs.writeFile(storePath, JSON.stringify(initialStore, null, 2), "utf-8");

    await migrateSessionStoreToDirectory(storePath);

    const loaded = loadSessionStore(storePath);
    expect(Object.keys(loaded)).toHaveLength(50);
    for (const key of keys) {
      expect(loaded[key]?.sessionId).toBe(initialStore[key].sessionId);
    }
  });

  it("returns false for empty JSON file", async () => {
    await fs.writeFile(storePath, "", "utf-8");
    const migrated = await migrateSessionStoreToDirectory(storePath);
    expect(migrated).toBe(false);
  });

  it("returns false when no JSON file exists", async () => {
    const migrated = await migrateSessionStoreToDirectory(storePath);
    expect(migrated).toBe(false);
  });

  it("merges legacy JSON entries into existing directory without clobbering", async () => {
    const now = Date.now();

    // Create directory store with one entry
    const storeDir = resolveSessionStoreDir(storePath);
    await fs.mkdir(storeDir, { recursive: true });
    const dirEntry = makeEntry(now, { modelOverride: "dir-model" });
    const dirKey = sanitizeSessionKey("agent:main:existing");
    await fs.writeFile(path.join(storeDir, `${dirKey}.json`), JSON.stringify(dirEntry), "utf-8");

    // Create legacy JSON with overlapping + new entries
    const legacyStore: Record<string, SessionEntry> = {
      "agent:main:existing": makeEntry(now - 5000, { modelOverride: "old-json-model" }),
      "agent:main:new-entry": makeEntry(now - 1000),
    };
    await fs.writeFile(storePath, JSON.stringify(legacyStore, null, 2), "utf-8");

    const migrated = await migrateSessionStoreToDirectory(storePath);
    expect(migrated).toBe(true);

    const loaded = loadSessionStore(storePath);
    // Existing directory entry should NOT be overwritten by stale JSON
    expect(loaded["agent:main:existing"]?.modelOverride).toBe("dir-model");
    // New entry from JSON should be migrated
    expect(loaded["agent:main:new-entry"]).toBeDefined();
  });

  it("deduplicates case-variant keys during migration, keeping newest", async () => {
    const now = Date.now();
    const newerEntry = makeEntry(now, { modelOverride: "newer" });
    const olderEntry = makeEntry(now - 5000, { modelOverride: "older" });

    // Legacy JSON has two keys that normalize to the same lowercase key.
    const legacyStore: Record<string, SessionEntry> = {
      "Agent:Main:Test": olderEntry,
      "agent:main:test": newerEntry,
    };
    await fs.writeFile(storePath, JSON.stringify(legacyStore, null, 2), "utf-8");

    const migrated = await migrateSessionStoreToDirectory(storePath);
    expect(migrated).toBe(true);

    const loaded = loadSessionStore(storePath);
    // Only one entry should exist, and it must be the newer one.
    expect(Object.keys(loaded)).toHaveLength(1);
    expect(loaded["agent:main:test"]?.modelOverride).toBe("newer");
  });

  it("deduplicates case-variant keys keeping stale-wins prevention", async () => {
    const now = Date.now();
    // Reverse order: newer key listed first, older listed second.
    // Without dedup, the older entry (iterated last) would overwrite the newer one.
    const legacyStore: Record<string, SessionEntry> = {
      "agent:main:test": makeEntry(now, { modelOverride: "newer" }),
      "AGENT:MAIN:TEST": makeEntry(now - 10000, { modelOverride: "older" }),
    };
    await fs.writeFile(storePath, JSON.stringify(legacyStore, null, 2), "utf-8");

    await migrateSessionStoreToDirectory(storePath);

    const loaded = loadSessionStore(storePath);
    expect(Object.keys(loaded)).toHaveLength(1);
    expect(loaded["agent:main:test"]?.modelOverride).toBe("newer");
  });

  it("cleans up stale staging directory from previous failed migration", async () => {
    const now = Date.now();
    const storeDir = resolveSessionStoreDir(storePath);
    const stagingDir = `${storeDir}.migrating`;

    // Simulate a leftover staging dir from a previous crash.
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.writeFile(path.join(stagingDir, "stale.json"), "{}", "utf-8");

    const legacyStore: Record<string, SessionEntry> = {
      "agent:main:test": makeEntry(now, { modelOverride: "fresh" }),
    };
    await fs.writeFile(storePath, JSON.stringify(legacyStore, null, 2), "utf-8");

    const migrated = await migrateSessionStoreToDirectory(storePath);
    expect(migrated).toBe(true);

    // Stale file should be gone, replaced by the real migration.
    const loaded = loadSessionStore(storePath);
    expect(loaded["agent:main:test"]?.modelOverride).toBe("fresh");
    const files = await fs.readdir(storeDir);
    expect(files.find((f) => f === "stale.json")).toBeUndefined();
  });
});

// ============================================================================
// Directory store: CRUD operations
// ============================================================================

describe("directory store operations", () => {
  let testDir: string;
  let storePath: string;

  beforeEach(async () => {
    testDir = await createCaseDir("dirstore");
    storePath = path.join(testDir, "sessions.json");
    // Create the directory store (no legacy JSON)
    const storeDir = resolveSessionStoreDir(storePath);
    await fs.mkdir(storeDir, { recursive: true });
  });

  it("loads empty store from empty directory", () => {
    const store = loadSessionStore(storePath);
    expect(Object.keys(store)).toHaveLength(0);
  });

  it("saves and loads entries via directory store", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:test": makeEntry(now, { modelOverride: "gpt-4" }),
    };

    await saveSessionStore(storePath, store);

    const loaded = loadSessionStore(storePath);
    expect(loaded["agent:main:test"]?.modelOverride).toBe("gpt-4");
  });

  it("creates per-session JSON files with sanitized names", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:telegram:direct:james": makeEntry(now),
    };

    await saveSessionStore(storePath, store);

    const storeDir = resolveSessionStoreDir(storePath);
    const expectedFile = `${sanitizeSessionKey("agent:main:telegram:direct:james")}.json`;
    const stat = await fs.stat(path.join(storeDir, expectedFile));
    expect(stat.isFile()).toBe(true);

    const content = JSON.parse(await fs.readFile(path.join(storeDir, expectedFile), "utf-8"));
    expect(content.sessionId).toBeDefined();
  });

  it("removes deleted entries from directory", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:keep": makeEntry(now),
      "agent:main:delete": makeEntry(now),
    };

    await saveSessionStore(storePath, store);

    // Remove one entry and save again
    delete store["agent:main:delete"];
    await saveSessionStore(storePath, store);

    const loaded = loadSessionStore(storePath);
    expect(loaded["agent:main:keep"]).toBeDefined();
    expect(loaded["agent:main:delete"]).toBeUndefined();

    // File should be removed
    const storeDir = resolveSessionStoreDir(storePath);
    const deletedFile = `${sanitizeSessionKey("agent:main:delete")}.json`;
    await expect(fs.stat(path.join(storeDir, deletedFile))).rejects.toThrow();
  });

  it("updateSessionStore with diff-based writes", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:a": makeEntry(now),
      "agent:main:b": makeEntry(now),
    };
    await saveSessionStore(storePath, store);

    await updateSessionStore(storePath, (s) => {
      s["agent:main:a"] = { ...s["agent:main:a"], modelOverride: "changed" } as SessionEntry;
      // b is untouched
    });

    const loaded = loadSessionStore(storePath);
    expect(loaded["agent:main:a"]?.modelOverride).toBe("changed");
    expect(loaded["agent:main:b"]).toBeDefined();
  });

  it("updateSessionStore after migration", async () => {
    // Start with legacy JSON
    const legacyDir = await createCaseDir("update-after-migrate");
    const legacyStorePath = path.join(legacyDir, "sessions.json");
    const now = Date.now();
    const initialStore: Record<string, SessionEntry> = {
      "agent:main:test": makeEntry(now),
    };
    await fs.writeFile(legacyStorePath, JSON.stringify(initialStore, null, 2), "utf-8");

    await migrateSessionStoreToDirectory(legacyStorePath);

    await updateSessionStore(legacyStorePath, (s) => {
      s["agent:main:test"] = {
        ...s["agent:main:test"],
        modelOverride: "updated",
      } as SessionEntry;
    });

    const loaded = loadSessionStore(legacyStorePath);
    expect(loaded["agent:main:test"]?.modelOverride).toBe("updated");
  });
});

// ============================================================================
// Per-session locking: concurrent writes to different sessions
// ============================================================================

describe("per-session locking isolation", () => {
  let testDir: string;
  let storePath: string;

  beforeEach(async () => {
    testDir = await createCaseDir("concurrent");
    storePath = path.join(testDir, "sessions.json");
    const storeDir = resolveSessionStoreDir(storePath);
    await fs.mkdir(storeDir, { recursive: true });
  });

  it("concurrent writes to different sessions complete without blocking", async () => {
    // Seed two sessions
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:session-a": makeEntry(now),
      "agent:main:session-b": makeEntry(now),
    };
    await saveSessionStore(storePath, store);

    // Concurrent updates to different sessions — should not block each other
    const results = await Promise.all([
      updateSessionStore(storePath, (s) => {
        s["agent:main:session-a"] = {
          ...s["agent:main:session-a"],
          modelOverride: "model-a",
        } as SessionEntry;
        return "a-done";
      }),
      updateSessionStore(storePath, (s) => {
        s["agent:main:session-b"] = {
          ...s["agent:main:session-b"],
          modelOverride: "model-b",
        } as SessionEntry;
        return "b-done";
      }),
    ]);

    expect(results).toContain("a-done");
    expect(results).toContain("b-done");

    const loaded = loadSessionStore(storePath);
    expect(loaded["agent:main:session-a"]?.modelOverride).toBe("model-a");
    expect(loaded["agent:main:session-b"]?.modelOverride).toBe("model-b");
  });

  it("sequential writes to the same session accumulate correctly", async () => {
    const now = Date.now();
    const key = "agent:main:counter";
    const storeDir = resolveSessionStoreDir(storePath);
    const sanitized = sanitizeSessionKey(key);
    await fs.writeFile(
      path.join(storeDir, `${sanitized}.json`),
      JSON.stringify({ sessionId: "s1", updatedAt: now, counter: 0 }),
      "utf-8",
    );

    // Sequential updates via updateSessionStore (each reads current state)
    for (let i = 0; i < 4; i++) {
      await updateSessionStore(storePath, (store) => {
        const entry = store[key] as Record<string, unknown>;
        entry.counter = (entry.counter as number) + 1;
      });
    }

    const loaded = loadSessionStore(storePath);
    // Each write reads current state, so counter should be 4
    expect((loaded[key] as Record<string, unknown>).counter).toBe(4);
  });
});

// ============================================================================
// Lock namespace: updateSessionStoreEntry serializes with updateSessionStore
// ============================================================================

describe("lock namespace: updateSessionStoreEntry vs updateSessionStore", () => {
  let testDir: string;
  let storePath: string;

  beforeEach(async () => {
    testDir = await createCaseDir("lock-namespace");
    storePath = path.join(testDir, "sessions.json");
    const storeDir = resolveSessionStoreDir(storePath);
    await fs.mkdir(storeDir, { recursive: true });
  });

  it("updateSessionStoreEntry and updateSessionStore do not lose each other's writes", async () => {
    const now = Date.now();
    const key = "agent:main:race-session";
    await saveSessionStore(storePath, {
      [key]: makeEntry(now, { modelOverride: "initial" }),
    });

    // Interleave both write paths sequentially (each reads current state).
    await updateSessionStore(storePath, (s) => {
      (s[key] as Record<string, unknown>).modelOverride = "from-updateSessionStore";
    });
    const result = await updateSessionStoreEntry({
      storePath,
      sessionKey: key,
      update: async (entry) => ({ ...entry, modelOverride: "from-updateSessionStoreEntry" }),
    });

    expect(result?.modelOverride).toBe("from-updateSessionStoreEntry");
    const loaded = loadSessionStore(storePath);
    expect(loaded[key]?.modelOverride).toBe("from-updateSessionStoreEntry");
  });
});

// ============================================================================
// readSessionUpdatedAt optimization
// ============================================================================

describe("readSessionUpdatedAt with directory store", () => {
  let testDir: string;
  let storePath: string;

  beforeEach(async () => {
    testDir = await createCaseDir("read-updated");
    storePath = path.join(testDir, "sessions.json");
    const storeDir = resolveSessionStoreDir(storePath);
    await fs.mkdir(storeDir, { recursive: true });
  });

  it("reads single entry without loading entire store", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:a": makeEntry(now - 1000),
      "agent:main:b": makeEntry(now),
    };
    await saveSessionStore(storePath, store);

    const updatedAt = readSessionUpdatedAt({
      storePath,
      sessionKey: "agent:main:b",
    });
    expect(updatedAt).toBe(now);
  });

  it("returns undefined for non-existent session", async () => {
    const updatedAt = readSessionUpdatedAt({
      storePath,
      sessionKey: "agent:main:missing",
    });
    expect(updatedAt).toBeUndefined();
  });
});

// ============================================================================
// Fresh install (no legacy JSON, no directory)
// ============================================================================

describe("fresh install behavior", () => {
  let testDir: string;
  let storePath: string;

  beforeEach(async () => {
    testDir = await createCaseDir("fresh");
    storePath = path.join(testDir, "sessions.json");
    // Don't create anything — simulates fresh install
  });

  it("loadSessionStore returns empty for non-existent store", () => {
    const store = loadSessionStore(storePath);
    expect(Object.keys(store)).toHaveLength(0);
  });

  it("fresh install uses JSON mode by default", async () => {
    const now = Date.now();

    await updateSessionStore(storePath, (store) => {
      store["agent:main:new"] = makeEntry(now);
    });

    // Fresh install: no sessions.json existed before, so no migration occurred.
    // Data is written to sessions.json (legacy mode).
    const stat = await fs.stat(storePath);
    expect(stat.isFile()).toBe(true);

    const loaded = loadSessionStore(storePath);
    expect(loaded["agent:main:new"]).toBeDefined();
  });

  it("fresh install can be migrated to directory mode", async () => {
    const now = Date.now();
    await saveSessionStore(storePath, { "agent:main:new": makeEntry(now) });

    const migrated = await migrateSessionStoreToDirectory(storePath);
    expect(migrated).toBe(true);

    const storeDir = resolveSessionStoreDir(storePath);
    const stat = await fs.stat(storeDir);
    expect(stat.isDirectory()).toBe(true);

    const loaded = loadSessionStore(storePath);
    expect(loaded["agent:main:new"]).toBeDefined();
  });

  it("migrateSessionStoreToDirectory then updateSessionStore works", async () => {
    // Seed a legacy sessions.json
    const now = Date.now();
    await fs.writeFile(
      storePath,
      JSON.stringify({ "agent:main:existing": makeEntry(now) }, null, 2),
      "utf-8",
    );

    // Explicit migration (called by gateway at startup)
    await migrateSessionStoreToDirectory(storePath);

    // Subsequent updateSessionStore uses directory mode
    await updateSessionStore(storePath, (store) => {
      store["agent:main:existing"] = {
        ...store["agent:main:existing"],
        modelOverride: "updated",
      } as SessionEntry;
    });

    const loaded = loadSessionStore(storePath);
    expect(loaded["agent:main:existing"]?.modelOverride).toBe("updated");
  });
});

// ============================================================================
// Multi-agent migration (gateway startup pattern)
// ============================================================================

describe("multi-agent migration via listAgentSessionDirs", () => {
  let fakeStateDir: string;

  beforeEach(async () => {
    fakeStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-multi-agent-"));
  });

  afterEach(async () => {
    await fs.rm(fakeStateDir, { recursive: true, force: true });
  });

  it("migrates all agent session directories found on disk", async () => {
    const agentIds = ["main", "dev", "doctor"];
    const now = Date.now();

    // Create fake agent session dirs with legacy sessions.json
    for (const id of agentIds) {
      const sessionsDir = path.join(fakeStateDir, "agents", id, "sessions");
      await fs.mkdir(sessionsDir, { recursive: true });
      const store: Record<string, SessionEntry> = {
        [`agent:${id}:test`]: makeEntry(now),
      };
      await fs.writeFile(
        path.join(sessionsDir, "sessions.json"),
        JSON.stringify(store, null, 2),
        "utf-8",
      );
    }

    // Scan + migrate (same pattern as server.impl.ts)
    const sessionDirs = await listAgentSessionDirs(fakeStateDir);
    expect(sessionDirs).toHaveLength(3);

    for (const sessionsDir of sessionDirs) {
      const storePath = path.join(sessionsDir, "sessions.json");
      const migrated = await migrateSessionStoreToDirectory(storePath);
      expect(migrated).toBe(true);
    }

    // Verify all agents have sessions.d and no sessions.json
    for (const id of agentIds) {
      const sessionsDir = path.join(fakeStateDir, "agents", id, "sessions");
      const dirStat = await fs.stat(path.join(sessionsDir, "sessions.d"));
      expect(dirStat.isDirectory()).toBe(true);

      await expect(fs.stat(path.join(sessionsDir, "sessions.json"))).rejects.toThrow();

      const loaded = loadSessionStore(path.join(sessionsDir, "sessions.json"));
      expect(loaded[`agent:${id}:test`]).toBeDefined();
    }
  });

  it("skips already-migrated agents and handles missing sessions gracefully", async () => {
    const now = Date.now();

    // "main" — already migrated (has sessions.d, no sessions.json)
    const mainDir = path.join(fakeStateDir, "agents", "main", "sessions");
    await fs.mkdir(path.join(mainDir, "sessions.d"), { recursive: true });

    // "dev" — has sessions.json to migrate
    const devDir = path.join(fakeStateDir, "agents", "dev", "sessions");
    await fs.mkdir(devDir, { recursive: true });
    await fs.writeFile(
      path.join(devDir, "sessions.json"),
      JSON.stringify({ "agent:dev:test": makeEntry(now) }, null, 2),
      "utf-8",
    );

    // "research" — agent dir exists but no sessions subdir content
    await fs.mkdir(path.join(fakeStateDir, "agents", "research"), { recursive: true });

    const sessionDirs = await listAgentSessionDirs(fakeStateDir);
    expect(sessionDirs).toHaveLength(3);

    const results: boolean[] = [];
    for (const sessionsDir of sessionDirs) {
      const storePath = path.join(sessionsDir, "sessions.json");
      results.push(await migrateSessionStoreToDirectory(storePath));
    }

    // Only dev should have been migrated
    expect(results.filter(Boolean)).toHaveLength(1);

    // dev data intact
    const loaded = loadSessionStore(path.join(devDir, "sessions.json"));
    expect(loaded["agent:dev:test"]).toBeDefined();
  });
});
