import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearSessionStoreCacheForTest,
  flushWriteBehindForTest,
  hasWriteBehindPending,
  loadSessionStore,
  updateSessionStore,
} from "./store.js";
import type { SessionEntry } from "./types.js";

/**
 * Tests for the write-behind persistence and filesystem-lock bypass features.
 *
 * These tests explicitly enable write-behind via the env var so they exercise
 * the production code path (write-behind is disabled by default in vitest).
 */
describe("session store write-behind", () => {
  let fixtureRoot = "";
  let caseId = 0;
  const tmpDirs: string[] = [];

  async function makeTmpStore(
    initial: Record<string, unknown> = {},
  ): Promise<{ dir: string; storePath: string }> {
    const dir = path.join(fixtureRoot, `wb-case-${caseId++}`);
    await fsPromises.mkdir(dir, { recursive: true });
    tmpDirs.push(dir);
    const storePath = path.join(dir, "sessions.json");
    if (Object.keys(initial).length > 0) {
      await fsPromises.writeFile(storePath, JSON.stringify(initial, null, 2), "utf-8");
    }
    return { dir, storePath };
  }

  beforeAll(async () => {
    fixtureRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-wb-test-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fsPromises.rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  beforeEach(() => {
    // Enable write-behind for these tests.
    process.env.OPENCLAW_SESSION_STORE_WRITE_BEHIND = "1";
    // Disable filesystem lock (not needed in single-process tests).
    process.env.OPENCLAW_SESSION_STORE_FSLOCK = "0";
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
    delete process.env.OPENCLAW_SESSION_STORE_WRITE_BEHIND;
    delete process.env.OPENCLAW_SESSION_STORE_FSLOCK;
  });

  it("defers disk write but returns correct data from in-memory cache", async () => {
    const key = "agent:main:wb-test";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: 100, counter: 0 },
    });

    await updateSessionStore(storePath, async (store) => {
      const entry = store[key] as Record<string, unknown>;
      entry.counter = 42;
    });

    // In-memory read should reflect the mutation immediately.
    const memoryStore = loadSessionStore(storePath);
    expect((memoryStore[key] as Record<string, unknown>).counter).toBe(42);

    // Disk should still have the old value (write is deferred).
    const diskRaw = fs.readFileSync(storePath, "utf-8");
    const diskStore = JSON.parse(diskRaw);
    expect(diskStore[key].counter).toBe(0);

    // After flushing, disk should match.
    await flushWriteBehindForTest(storePath);
    const diskRawAfterFlush = fs.readFileSync(storePath, "utf-8");
    const diskStoreAfterFlush = JSON.parse(diskRawAfterFlush);
    expect(diskStoreAfterFlush[key].counter).toBe(42);
  });

  it("marks store as dirty until flushed", async () => {
    const key = "agent:main:dirty-check";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: 100 },
    });

    expect(hasWriteBehindPending(storePath)).toBe(false);

    await updateSessionStore(storePath, async (store) => {
      store[key] = { ...store[key], modelOverride: "test" } as unknown as SessionEntry;
    });

    expect(hasWriteBehindPending(storePath)).toBe(true);

    await flushWriteBehindForTest(storePath);
    expect(hasWriteBehindPending(storePath)).toBe(false);
  });

  it("coalesces multiple rapid mutations into one disk write", async () => {
    const key = "agent:main:coalesce";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: 100, counter: 0 },
    });

    // Perform 10 rapid mutations.
    for (let i = 1; i <= 10; i++) {
      await updateSessionStore(storePath, async (store) => {
        const entry = store[key] as Record<string, unknown>;
        entry.counter = i;
      });
    }

    // In-memory should have the final value.
    const store = loadSessionStore(storePath);
    expect((store[key] as Record<string, unknown>).counter).toBe(10);

    // Disk still has old value (one pending flush, not 10).
    const diskRaw = fs.readFileSync(storePath, "utf-8");
    expect(JSON.parse(diskRaw)[key].counter).toBe(0);

    // Flush once → disk updated.
    await flushWriteBehindForTest(storePath);
    const flushed = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(flushed[key].counter).toBe(10);
  });

  it("serializes concurrent mutations without data loss", async () => {
    const key = "agent:main:concurrent-wb";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: 100, counter: 0 },
    });

    const N = 20;
    await Promise.all(
      Array.from({ length: N }, () =>
        updateSessionStore(storePath, async (store) => {
          const entry = store[key] as Record<string, unknown>;
          await Promise.resolve(); // Simulate async work.
          entry.counter = (entry.counter as number) + 1;
        }),
      ),
    );

    const store = loadSessionStore(storePath);
    expect((store[key] as Record<string, unknown>).counter).toBe(N);
  });

  it("reads from in-memory cache even with skipCache when dirty", async () => {
    const key = "agent:main:skip-cache-dirty";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: 100, value: "original" },
    });

    await updateSessionStore(storePath, async (store) => {
      (store[key] as Record<string, unknown>).value = "updated";
    });

    // Even with skipCache, dirty write-behind should return in-memory data.
    const store = loadSessionStore(storePath, { skipCache: true });
    expect((store[key] as Record<string, unknown>).value).toBe("updated");
  });
});

describe("session store filesystem lock bypass", () => {
  let fixtureRoot = "";
  let caseId = 0;

  async function makeTmpStore(
    initial: Record<string, unknown> = {},
  ): Promise<{ dir: string; storePath: string }> {
    const dir = path.join(fixtureRoot, `fslock-case-${caseId++}`);
    await fsPromises.mkdir(dir, { recursive: true });
    const storePath = path.join(dir, "sessions.json");
    if (Object.keys(initial).length > 0) {
      await fsPromises.writeFile(storePath, JSON.stringify(initial, null, 2), "utf-8");
    }
    return { dir, storePath };
  }

  beforeAll(async () => {
    fixtureRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-fslock-test-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fsPromises.rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
    delete process.env.OPENCLAW_SESSION_STORE_FSLOCK;
    delete process.env.OPENCLAW_SESSION_STORE_WRITE_BEHIND;
  });

  it("does not create a .lock file when OPENCLAW_SESSION_STORE_FSLOCK is unset", async () => {
    process.env.OPENCLAW_SESSION_STORE_FSLOCK = "0";
    process.env.OPENCLAW_SESSION_STORE_WRITE_BEHIND = "0";
    const key = "agent:main:no-lock";
    const { dir, storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: 100 },
    });

    await updateSessionStore(storePath, async (store) => {
      store[key] = { ...store[key], modelOverride: "test" } as unknown as SessionEntry;
    });

    const files = await fsPromises.readdir(dir);
    const lockFiles = files.filter((f) => f.endsWith(".lock"));
    expect(lockFiles).toHaveLength(0);
  });

  it("many concurrent writers succeed without filesystem lock", async () => {
    process.env.OPENCLAW_SESSION_STORE_FSLOCK = "0";
    process.env.OPENCLAW_SESSION_STORE_WRITE_BEHIND = "0";
    const key = "agent:main:many-writers";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: 100, counter: 0 },
    });

    const N = 50;
    await Promise.all(
      Array.from({ length: N }, () =>
        updateSessionStore(storePath, async (store) => {
          const entry = store[key] as Record<string, unknown>;
          await Promise.resolve();
          entry.counter = (entry.counter as number) + 1;
        }),
      ),
    );

    const store = loadSessionStore(storePath);
    expect((store[key] as Record<string, unknown>).counter).toBe(N);
  });
});
