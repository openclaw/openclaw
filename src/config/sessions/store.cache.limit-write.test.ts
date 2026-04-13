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

const LARGE_STORE_LIMIT_BYTES = 1_000_000;

function createSmallSessionStore(): Record<string, SessionEntry> {
  return {
    "session:1": {
      sessionId: "id-1",
      updatedAt: Date.now(),
      displayName: "Small Session",
    },
  };
}

function createLargeSessionStore(): Record<string, SessionEntry> {
  const repeated = "x".repeat(4096);
  const now = Date.now();
  const store: Record<string, SessionEntry> = {};
  for (let i = 0; i < 320; i += 1) {
    store[`session:${String(i)}`] = {
      sessionId: `id-${String(i)}`,
      updatedAt: now + i,
      displayName: `Large Session ${String(i)} ${repeated}`,
    };
  }
  return store;
}

describe("session object cache write limit", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let testDir = "";
  let storePath = "";

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-cache-limit-write-test-"));
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

  it("does not keep an oversized write-through cache entry after save", async () => {
    await saveSessionStore(storePath, createLargeSessionStore());

    expect(fs.statSync(storePath).size).toBeGreaterThan(LARGE_STORE_LIMIT_BYTES);

    process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES = String(LARGE_STORE_LIMIT_BYTES * 2);
    const readSpy = vi.spyOn(fs, "readFileSync");

    loadSessionStore(storePath);

    expect(readSpy).toHaveBeenCalledTimes(1);
    readSpy.mockRestore();
  });

  it("does not repopulate the object cache after loading an oversized store from disk", async () => {
    await saveSessionStore(storePath, createLargeSessionStore());

    expect(fs.statSync(storePath).size).toBeGreaterThan(LARGE_STORE_LIMIT_BYTES);

    loadSessionStore(storePath);

    process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES = String(LARGE_STORE_LIMIT_BYTES * 2);
    const readSpy = vi.spyOn(fs, "readFileSync");

    loadSessionStore(storePath);

    expect(readSpy).toHaveBeenCalledTimes(1);
    readSpy.mockRestore();
  });

  it("drops object-cache eligibility immediately when a store grows past the limit", async () => {
    await saveSessionStore(storePath, createSmallSessionStore());
    loadSessionStore(storePath);

    await saveSessionStore(storePath, createLargeSessionStore());

    process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES = String(LARGE_STORE_LIMIT_BYTES * 2);
    const readSpy = vi.spyOn(fs, "readFileSync");

    loadSessionStore(storePath);

    expect(readSpy).toHaveBeenCalledTimes(1);
    readSpy.mockRestore();
  });

  it("keeps normal write-through caching for small stores", async () => {
    process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES = "1024";
    await saveSessionStore(storePath, createSmallSessionStore());

    const readSpy = vi.spyOn(fs, "readFileSync");

    loadSessionStore(storePath);
    loadSessionStore(storePath);

    expect(readSpy).toHaveBeenCalledTimes(0);
    readSpy.mockRestore();
  });
});
