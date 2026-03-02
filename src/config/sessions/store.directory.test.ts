import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  saveSessionStore,
  updateSessionStore,
  migrateSessionStoreToDirectory,
  resolveSessionStoreDir,
  sanitizeSessionKey,
  desanitizeSessionKey,
} from "./store.js";
import type { SessionEntry } from "./types.js";

// Mock config to avoid reading real openclaw.json
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
  it("replaces colons with double-dash", () => {
    expect(sanitizeSessionKey("agent:main:telegram:direct:james")).toBe(
      "agent--main--telegram--direct--james",
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
// Migration: JSON → directory
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

    // Explicit migration
    const migrated = await migrateSessionStoreToDirectory(storePath);
    expect(migrated).toBe(true);

    // Directory store should exist
    const storeDir = resolveSessionStoreDir(storePath);
    const stat = await fs.stat(storeDir);
    expect(stat.isDirectory()).toBe(true);

    // Original JSON should be backed up (renamed)
    const dirEntries = await fs.readdir(testDir);
    const backupFiles = dirEntries.filter((f) => f.includes("pre-directory-migration"));
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
    expect(second).toBe(false); // Already migrated
  });

  it("updateSessionStore works after migration", async () => {
    const now = Date.now();
    const initialStore: Record<string, SessionEntry> = {
      "agent:main:test": makeEntry(now),
    };
    await fs.writeFile(storePath, JSON.stringify(initialStore, null, 2), "utf-8");

    await migrateSessionStoreToDirectory(storePath);

    await updateSessionStore(storePath, (store) => {
      store["agent:main:test"] = {
        ...store["agent:main:test"],
        modelOverride: "updated",
      } as SessionEntry;
    });

    const loaded = loadSessionStore(storePath);
    expect(loaded["agent:main:test"]?.modelOverride).toBe("updated");
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

  it("creates per-session directories with meta.json files", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:telegram:direct:james": makeEntry(now),
    };

    await saveSessionStore(storePath, store);

    const storeDir = resolveSessionStoreDir(storePath);
    const metaPath = path.join(storeDir, "agent--main--telegram--direct--james", "meta.json");
    const stat = await fs.stat(metaPath);
    expect(stat.isFile()).toBe(true);

    const content = JSON.parse(await fs.readFile(metaPath, "utf-8"));
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

    // Directory should be removed
    const storeDir = resolveSessionStoreDir(storePath);
    const deletedDir = path.join(storeDir, "agent--main--delete");
    await expect(fs.stat(deletedDir)).rejects.toThrow();
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
});

// ============================================================================
// Concurrent writes
// ============================================================================

describe("concurrent per-session writes", () => {
  let testDir: string;
  let storePath: string;

  beforeEach(async () => {
    testDir = await createCaseDir("concurrent");
    storePath = path.join(testDir, "sessions.json");
    const storeDir = resolveSessionStoreDir(storePath);
    await fs.mkdir(storeDir, { recursive: true });
  });

  it("serializes concurrent updateSessionStore calls without data loss", async () => {
    const key = "agent:main:test";
    const storeDir = resolveSessionStoreDir(storePath);
    const sanitized = sanitizeSessionKey(key);
    const entryDir = path.join(storeDir, sanitized);
    await fs.mkdir(entryDir, { recursive: true });
    await fs.writeFile(
      path.join(entryDir, "meta.json"),
      JSON.stringify({ sessionId: "s1", updatedAt: 100, counter: 0 }),
      "utf-8",
    );

    const N = 4;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        updateSessionStore(storePath, async (store) => {
          const entry = store[key] as Record<string, unknown>;
          await Promise.resolve();
          entry.counter = (entry.counter as number) + 1;
          entry.tag = `writer-${i}`;
        }),
      ),
    );

    const loaded = loadSessionStore(storePath);
    expect((loaded[key] as Record<string, unknown>).counter).toBe(N);
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

    // Import readSessionUpdatedAt
    const { readSessionUpdatedAt } = await import("./store.js");
    const updatedAt = readSessionUpdatedAt({
      storePath,
      sessionKey: "agent:main:b",
    });
    expect(updatedAt).toBeGreaterThanOrEqual(now);
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

  it("fresh install uses JSON mode by default", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:new": makeEntry(now),
    };

    await saveSessionStore(storePath, store);

    // Should create sessions.json, not sessions.d/
    const stat = await fs.stat(storePath);
    expect(stat.isFile()).toBe(true);

    const loaded = loadSessionStore(storePath);
    expect(loaded["agent:main:new"]).toBeDefined();
  });

  it("fresh install can be migrated to directory mode", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:new": makeEntry(now),
    };
    await saveSessionStore(storePath, store);

    const migrated = await migrateSessionStoreToDirectory(storePath);
    expect(migrated).toBe(true);

    const storeDir = resolveSessionStoreDir(storePath);
    const stat = await fs.stat(storeDir);
    expect(stat.isDirectory()).toBe(true);

    const loaded = loadSessionStore(storePath);
    expect(loaded["agent:main:new"]).toBeDefined();
  });

  it("loadSessionStore returns empty for non-existent store", () => {
    const store = loadSessionStore(storePath);
    expect(Object.keys(store)).toHaveLength(0);
  });
});
