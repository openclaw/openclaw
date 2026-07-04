// Regression tests for transient EAGAIN/EINTR handling in session store reads.
// See https://github.com/openclaw/openclaw/issues/99994.
//
// On macOS, heartbeat-driven reads of the session store can surface EAGAIN
// (or the "Unknown system error -11" form) when another process is swapping
// the file. loadSessionStore must retry a few times rather than propagating
// the error, which would otherwise make the caller treat the store as empty
// and lose track of active sessions.
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionStoreCacheForTest, loadSessionStore } from "./store.js";
import { writeSessionStoreForTest } from "./test-helpers.js";
import type { SessionEntry } from "./types.js";

let tempDir: string | undefined;
let storePath: string | undefined;

beforeEach(() => {
  tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-store-eagain-"));
  storePath = path.join(tempDir, "sessions.json");
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSessionStoreCacheForTest();
  if (tempDir) {
    fsSync.rmSync(tempDir, { recursive: true, force: true });
  }
  tempDir = undefined;
  storePath = undefined;
});

function makeEntry(id: string): SessionEntry {
  return {
    sessionId: id,
    updatedAt: Date.now(),
  } as unknown as SessionEntry;
}

function makeEagainError(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error("EAGAIN");
  err.code = "EAGAIN";
  err.errno = -11;
  return err;
}

describe("loadSessionStore EAGAIN retry", () => {
  it("retries readFileSync on EAGAIN and loads the store once the read succeeds", () => {
    writeSessionStoreForTest(storePath!, {
      "agent:main:sess-a": makeEntry("sess-a"),
    });

    let calls = 0;
    const realReadFileSync = fsSync.readFileSync;
    vi.spyOn(fsSync, "readFileSync").mockImplementation((...args) => {
      calls += 1;
      if (calls < 3) {
        throw makeEagainError();
      }
      vi.mocked(fsSync.readFileSync).mockRestore();
      return realReadFileSync(...args);
    });

    const store = loadSessionStore(storePath!, { skipCache: true });
    expect(store["agent:main:sess-a"]?.sessionId).toBe("sess-a");
    expect(calls).toBe(3);
  });

  it("returns an empty store after exhausting retries on persistent EAGAIN", () => {
    writeSessionStoreForTest(storePath!, {
      "agent:main:sess-b": makeEntry("sess-b"),
    });

    let calls = 0;
    vi.spyOn(fsSync, "readFileSync").mockImplementation(() => {
      calls += 1;
      throw makeEagainError();
    });

    const store = loadSessionStore(storePath!, { skipCache: true });
    expect(Object.keys(store)).toEqual([]);
    expect(calls).toBe(3);
  });

  it("retries on the macOS 'Unknown system error -11' message form", () => {
    writeSessionStoreForTest(storePath!, {
      "agent:main:sess-c": makeEntry("sess-c"),
    });

    let calls = 0;
    const realReadFileSync = fsSync.readFileSync;
    vi.spyOn(fsSync, "readFileSync").mockImplementation((...args) => {
      calls += 1;
      if (calls < 2) {
        throw new Error("Unknown system error -11");
      }
      vi.mocked(fsSync.readFileSync).mockRestore();
      return realReadFileSync(...args);
    });

    const store = loadSessionStore(storePath!, { skipCache: true });
    expect(store["agent:main:sess-c"]?.sessionId).toBe("sess-c");
    expect(calls).toBe(2);
  });

  it("retries on transient empty reads (race with file swap)", () => {
    writeSessionStoreForTest(storePath!, {
      "agent:main:sess-d": makeEntry("sess-d"),
    });

    let calls = 0;
    const realReadFileSync = fsSync.readFileSync;
    vi.spyOn(fsSync, "readFileSync").mockImplementation((...args) => {
      calls += 1;
      if (calls < 2) {
        return "" as string;
      }
      vi.mocked(fsSync.readFileSync).mockRestore();
      return realReadFileSync(...args);
    });

    const store = loadSessionStore(storePath!, { skipCache: true });
    expect(store["agent:main:sess-d"]?.sessionId).toBe("sess-d");
    expect(calls).toBe(2);
  });

  // P2 fix (#99994): missing store (ENOENT) must return immediately without
  // burning two 50ms Atomics.wait pauses. The retry loop is for transient
  // failures only; a genuinely absent store is the happy empty-store path.
  it("returns an empty store immediately on ENOENT (no retry waits)", () => {
    // No file written — readFileSync throws ENOENT on first call.
    let calls = 0;
    const start = Date.now();
    vi.spyOn(fsSync, "readFileSync").mockImplementation(() => {
      calls += 1;
      const err: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory");
      err.code = "ENOENT";
      err.errno = -2;
      throw err;
    });

    const store = loadSessionStore(storePath!, { skipCache: true });
    const elapsed = Date.now() - start;

    expect(Object.keys(store)).toEqual([]);
    // Single attempt — permanent failure breaks out of the retry loop.
    expect(calls).toBe(1);
    // Should complete well under 50ms; two Atomics.wait pauses would be ~100ms.
    expect(elapsed).toBeLessThan(40);
  });

  // P2 fix (#99994): EACCES (permission denied) is also permanent and must
  // not trigger retries.
  it("returns an empty store immediately on EACCES (no retry waits)", () => {
    writeSessionStoreForTest(storePath!, {
      "agent:main:sess-e": makeEntry("sess-e"),
    });

    let calls = 0;
    const start = Date.now();
    vi.spyOn(fsSync, "readFileSync").mockImplementation(() => {
      calls += 1;
      const err: NodeJS.ErrnoException = new Error("EACCES: permission denied");
      err.code = "EACCES";
      err.errno = -13;
      throw err;
    });

    const store = loadSessionStore(storePath!, { skipCache: true });
    const elapsed = Date.now() - start;

    expect(Object.keys(store)).toEqual([]);
    expect(calls).toBe(1);
    expect(elapsed).toBeLessThan(40);
  });
});
