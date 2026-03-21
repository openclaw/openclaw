import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearSessionStoreCacheForTest, loadSessionStore, saveSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

function createSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "id-1",
    updatedAt: Date.now(),
    displayName: "Test Session 1",
    ...overrides,
  };
}

describe("loadSessionStore readOnly option", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let testDir: string;
  let storePath: string;

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "store-readonly-test-"));
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
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
    delete process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
  });

  it("readOnly returns same reference from cache on subsequent calls (no clone)", async () => {
    const entry = createSessionEntry();
    await saveSessionStore(storePath, { "s:1": entry });

    // First call populates cache from disk — returned object is not the cached clone.
    loadSessionStore(storePath, { readOnly: true });
    // Second and third calls hit cache and return the cached reference directly.
    const b = loadSessionStore(storePath, { readOnly: true });
    const c = loadSessionStore(storePath, { readOnly: true });
    expect(b).toBe(c);
  });

  it("default (non-readOnly) returns a distinct clone", async () => {
    const entry = createSessionEntry();
    await saveSessionStore(storePath, { "s:1": entry });

    const a = loadSessionStore(storePath);
    const b = loadSessionStore(storePath);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
