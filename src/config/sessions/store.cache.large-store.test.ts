import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  saveSessionStore,
  type SessionEntry,
} from "../sessions.js";

const LARGE_STORE_MIN_BYTES = 1_000_000;

function createLargeSessionStore(): Record<string, SessionEntry> {
  const repeated = "x".repeat(4096);
  const store: Record<string, SessionEntry> = {};
  const now = Date.now();
  for (let i = 0; i < 320; i += 1) {
    store[`session:${String(i)}`] = {
      sessionId: `id-${String(i)}`,
      updatedAt: now + i,
      displayName: `Large Session ${String(i)} ${repeated}`,
    };
  }
  return store;
}

describe("Session Store Cache large store baseline", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let testDir = "";
  let storePath = "";

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-cache-large-store-test-"));
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
    clearSessionStoreCacheForTest();
    delete process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    delete process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES;
  });

  it("keeps a >1 MB store in the write-through cache when the limit is raised", async () => {
    const store = createLargeSessionStore();
    process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES = String(LARGE_STORE_MIN_BYTES * 2);

    await saveSessionStore(storePath, store);

    const sizeBytes = fs.statSync(storePath).size;
    expect(sizeBytes).toBeGreaterThan(LARGE_STORE_MIN_BYTES);

    const readSpy = vi.spyOn(fs, "readFileSync");

    const loaded1 = loadSessionStore(storePath);
    const loaded2 = loadSessionStore(storePath);

    expect(Object.keys(loaded1)).toHaveLength(Object.keys(store).length);
    expect(Object.keys(loaded2)).toHaveLength(Object.keys(store).length);
    expect(readSpy).toHaveBeenCalledTimes(0);

    readSpy.mockRestore();
  });

  it("falls back to disk for the same large store when cache TTL is disabled", async () => {
    const store = createLargeSessionStore();
    process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES = String(LARGE_STORE_MIN_BYTES * 2);

    await saveSessionStore(storePath, store);

    const sizeBytes = fs.statSync(storePath).size;
    expect(sizeBytes).toBeGreaterThan(LARGE_STORE_MIN_BYTES);

    process.env.OPENCLAW_SESSION_CACHE_TTL_MS = "0";
    clearSessionStoreCacheForTest();

    const readSpy = vi.spyOn(fs, "readFileSync");

    const loaded = loadSessionStore(storePath);

    expect(Object.keys(loaded)).toHaveLength(Object.keys(store).length);
    expect(readSpy).toHaveBeenCalledTimes(1);

    readSpy.mockRestore();
  });
});
