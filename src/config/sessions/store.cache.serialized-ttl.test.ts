import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionStoreCacheForTest, saveSessionStore, type SessionEntry } from "../sessions.js";
import {
  clearSessionStoreCaches,
  getSerializedSessionStore,
  setSerializedSessionStore,
} from "./store-cache.js";

describe("session serialized cache ttl", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-cache-serialized-ttl-test-"));
  });

  afterAll(() => {
    if (fixtureRoot) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:00:00.000Z"));
    clearSessionStoreCaches();
    clearSessionStoreCacheForTest();
    delete process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    delete process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES;
  });

  afterEach(() => {
    clearSessionStoreCaches();
    clearSessionStoreCacheForTest();
    delete process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    delete process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES;
    vi.useRealTimers();
  });

  it("expires serialized entries after the cache ttl", () => {
    const storePath = "/tmp/sessions.json";

    setSerializedSessionStore(storePath, '{"session":1}');
    expect(getSerializedSessionStore({ storePath, ttlMs: 10 })).toBe('{"session":1}');

    vi.advanceTimersByTime(11);

    expect(getSerializedSessionStore({ storePath, ttlMs: 10 })).toBeUndefined();
  });

  it("treats ttl=0 as disabled for serialized entries", () => {
    const storePath = "/tmp/sessions.json";

    setSerializedSessionStore(storePath, '{"session":1}');

    expect(getSerializedSessionStore({ storePath, ttlMs: 0 })).toBeUndefined();
  });

  it("does not retain serialized cache entries for oversized stores", async () => {
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

    const testDir = path.join(fixtureRoot, `case-${caseId++}`);
    fs.mkdirSync(testDir, { recursive: true });
    const storePath = path.join(testDir, "sessions.json");

    await saveSessionStore(storePath, store);

    expect(fs.statSync(storePath).size).toBeGreaterThan(1_000_000);
    expect(getSerializedSessionStore({ storePath, ttlMs: 45_000 })).toBeUndefined();
  });
});
