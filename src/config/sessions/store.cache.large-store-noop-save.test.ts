import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearSessionStoreCacheForTest, saveSessionStore, type SessionEntry } from "../sessions.js";

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

describe("large session-store no-op saves", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let testDir = "";
  let storePath = "";

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-cache-large-noop-save-test-"));
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

  it("does not rewrite unchanged oversized stores", async () => {
    const store = createLargeSessionStore();

    await saveSessionStore(storePath, store);
    expect(fs.statSync(storePath).size).toBeGreaterThan(1_000_000);

    const before = fs.statSync(storePath);
    await new Promise((resolve) => setTimeout(resolve, 25));

    await saveSessionStore(storePath, store);

    const after = fs.statSync(storePath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
