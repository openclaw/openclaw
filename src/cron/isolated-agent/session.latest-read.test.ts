// Behavior tests for the cron lifecycle-guard session read.
// loadCronSessionEntryLatest must observe the latest persisted row even when a
// cached in-process store snapshot is still considered current, because cron
// admission guards fence on it (see run.ts assertAllowed).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { clearSessionStoreCacheForTest, loadSessionStore } from "../../config/sessions/store.js";
import { loadCronSessionEntryLatest } from "./session.js";

const SESSION_KEY = "agent:main:cron:job-1";
const tempDirs: string[] = [];

function createStoreFile(sessionId: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cron-latest-")));
  tempDirs.push(dir);
  const storePath = path.join(dir, "sessions.json");
  fs.writeFileSync(storePath, serializeStore(sessionId), "utf-8");
  return storePath;
}

// Both serializations must have identical byte length so an out-of-band rewrite
// with a restored mtime looks unchanged to the mtime/size-validated cache.
function serializeStore(sessionId: string): string {
  return JSON.stringify({ [SESSION_KEY]: { sessionId, updatedAt: 1000 } });
}

afterEach(() => {
  vi.unstubAllEnvs();
  clearSessionStoreCacheForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("reads the latest persisted row past a still-current cached store snapshot", () => {
  vi.stubEnv("OPENCLAW_SESSION_CACHE_TTL_MS", "45000");
  clearSessionStoreCacheForTest();
  const storePath = createStoreFile("sess-one");
  // A whole-second mtime round-trips exactly through utimes/stat, so the
  // rewritten file below validates as unchanged against the cached snapshot.
  const pinnedTime = new Date(1_700_000_000_000);
  fs.utimesSync(storePath, pinnedTime, pinnedTime);

  // Warm the in-process cache, then rewrite the row out-of-band with the same
  // byte length and mtime so the cached snapshot still validates as current.
  expect(loadSessionStore(storePath)[SESSION_KEY]?.sessionId).toBe("sess-one");
  fs.writeFileSync(storePath, serializeStore("sess-two"), "utf-8");
  fs.utimesSync(storePath, pinnedTime, pinnedTime);

  expect(loadSessionStore(storePath)[SESSION_KEY]?.sessionId).toBe("sess-one");
  expect(loadCronSessionEntryLatest(storePath, SESSION_KEY)?.sessionId).toBe("sess-two");
});

it("returns undefined for a session key without a persisted row", () => {
  const storePath = createStoreFile("sess-one");
  expect(loadCronSessionEntryLatest(storePath, "agent:main:cron:missing")).toBeUndefined();
});
