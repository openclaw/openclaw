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

describe("session object cache read limit", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let testDir = "";
  let storePath = "";

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-cache-limit-read-test-"));
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

  it("keeps using the object cache for small stores", async () => {
    await saveSessionStore(storePath, createSmallSessionStore());

    const readSpy = vi.spyOn(fs, "readFileSync");

    loadSessionStore(storePath);
    loadSessionStore(storePath);

    expect(readSpy).toHaveBeenCalledTimes(0);
    readSpy.mockRestore();
  });

  it("skips the object cache for large stores above the default limit", async () => {
    await saveSessionStore(storePath, createLargeSessionStore());

    expect(fs.statSync(storePath).size).toBeGreaterThan(LARGE_STORE_LIMIT_BYTES);

    const readSpy = vi.spyOn(fs, "readFileSync");

    loadSessionStore(storePath);
    loadSessionStore(storePath);

    expect(readSpy).toHaveBeenCalledTimes(2);
    readSpy.mockRestore();
  });

  it("disables object-cache reads entirely when the limit is set to zero", async () => {
    process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES = "0";
    await saveSessionStore(storePath, createSmallSessionStore());

    const readSpy = vi.spyOn(fs, "readFileSync");

    loadSessionStore(storePath);
    loadSessionStore(storePath);

    expect(readSpy).toHaveBeenCalledTimes(2);
    readSpy.mockRestore();
  });
});
