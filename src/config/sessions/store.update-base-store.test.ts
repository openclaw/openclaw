import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionStoreCacheForTest,
  getLoadedSessionStoreSnapshotForTest,
  loadSessionStore,
  saveSessionStore,
  updateSessionStore,
  type SessionEntry,
} from "../sessions.js";

function createStore(): Record<string, SessionEntry> {
  return {
    "session:1": {
      sessionId: "id-1",
      updatedAt: 1,
      displayName: "Session 1",
      label: "initial",
    },
    "session:2": {
      sessionId: "id-2",
      updatedAt: 2,
      displayName: "Session 2",
      label: "stable",
    },
  };
}

function createLargeStore(): Record<string, SessionEntry> {
  const repeated = "x".repeat(4096);
  const store: Record<string, SessionEntry> = {};
  const now = Date.now();
  for (let i = 0; i < 320; i += 1) {
    store[`session:${String(i)}`] = {
      sessionId: `id-${String(i)}`,
      updatedAt: now + i,
      displayName: `Large Session ${String(i)} ${repeated}`,
      label: `initial-${String(i)}`,
    };
  }
  return store;
}

describe("session store base snapshot reuse", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let testDir = "";
  let storePath = "";

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-store-base-snapshot-test-"));
  });

  afterAll(() => {
    if (fixtureRoot) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    testDir = path.join(fixtureRoot, `case-${caseId++}`);
    fs.mkdirSync(testDir, { recursive: true });
    storePath = path.join(testDir, "sessions.json");
    clearSessionStoreCacheForTest();
    delete process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    delete process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearSessionStoreCacheForTest();
    delete process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    delete process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES;
  });

  it("reuses an unchanged loaded store snapshot without reparsing the file", async () => {
    await saveSessionStore(storePath, createStore(), { skipMaintenance: true });

    const baseStore = loadSessionStore(storePath, { skipCache: true });
    expect(getLoadedSessionStoreSnapshotForTest(baseStore)).toEqual({
      hasSerializedDigest: false,
      hasSerializedFromDisk: true,
    });
    const parseSpy = vi.spyOn(JSON, "parse");
    parseSpy.mockClear();

    await updateSessionStore(
      storePath,
      (store) => {
        store["session:1"] = {
          ...store["session:1"],
          label: "updated-once",
        };
      },
      { skipMaintenance: true, baseStore },
    );

    await updateSessionStore(
      storePath,
      (store) => {
        store["session:1"] = {
          ...store["session:1"],
          label: "updated-twice",
        };
      },
      { skipMaintenance: true, baseStore },
    );

    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();

    const saved = loadSessionStore(storePath, { skipCache: true });
    expect(saved["session:1"].label).toBe("updated-twice");
  });

  it("falls back to reparsing when the on-disk store changed", async () => {
    await saveSessionStore(storePath, createStore(), { skipMaintenance: true });

    const baseStore = loadSessionStore(storePath, { skipCache: true });
    const concurrent = loadSessionStore(storePath, { skipCache: true });
    concurrent["session:2"] = {
      ...concurrent["session:2"],
      label: "concurrent-change",
    };
    await saveSessionStore(storePath, concurrent, { skipMaintenance: true });

    const parseSpy = vi.spyOn(JSON, "parse");
    parseSpy.mockClear();

    await updateSessionStore(
      storePath,
      (store) => {
        store["session:1"] = {
          ...store["session:1"],
          label: "updated-after-fallback",
        };
      },
      { skipMaintenance: true, baseStore },
    );

    expect(parseSpy).toHaveBeenCalled();
    parseSpy.mockRestore();

    const saved = loadSessionStore(storePath, { skipCache: true });
    expect(saved["session:1"].label).toBe("updated-after-fallback");
    expect(saved["session:2"].label).toBe("concurrent-change");
  });

  it("reuses an unchanged oversized loaded store snapshot without reparsing the file", async () => {
    await saveSessionStore(storePath, createLargeStore(), { skipMaintenance: true });

    expect(fs.statSync(storePath).size).toBeGreaterThan(1_000_000);

    const baseStore = loadSessionStore(storePath, { skipCache: true });
    expect(getLoadedSessionStoreSnapshotForTest(baseStore)).toEqual({
      hasSerializedDigest: true,
      hasSerializedFromDisk: false,
    });
    const parseSpy = vi.spyOn(JSON, "parse");
    parseSpy.mockClear();

    await updateSessionStore(
      storePath,
      (store) => {
        store["session:1"] = {
          ...store["session:1"],
          label: "updated-large-once",
        };
      },
      { skipMaintenance: true, baseStore },
    );

    await updateSessionStore(
      storePath,
      (store) => {
        store["session:1"] = {
          ...store["session:1"],
          label: "updated-large-twice",
        };
      },
      { skipMaintenance: true, baseStore },
    );

    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
    expect(getLoadedSessionStoreSnapshotForTest(baseStore)).toEqual({
      hasSerializedDigest: true,
      hasSerializedFromDisk: false,
    });

    const saved = loadSessionStore(storePath, { skipCache: true });
    expect(saved["session:1"].label).toBe("updated-large-twice");
  });
});
