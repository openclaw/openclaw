import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const acquireSessionWriteLockMock = vi.hoisted(() =>
  vi.fn(async () => ({ release: vi.fn(async () => {}) })),
);

let cleanupSessionStateForTest: typeof import("./session-state-cleanup.js").cleanupSessionStateForTest;
let withSessionStoreLockForTest: typeof import("../config/sessions/store.js").withSessionStoreLockForTest;
let getSessionStoreLockQueueSizeForTest: typeof import("../config/sessions/store.js").getSessionStoreLockQueueSizeForTest;
let clearSessionStoreCacheForTest: typeof import("../config/sessions/store.js").clearSessionStoreCacheForTest;
let resetFileLockStateForTest: typeof import("../infra/file-lock.js").resetFileLockStateForTest;
let resetSessionWriteLockStateForTest: typeof import("../agents/session-write-lock.js").resetSessionWriteLockStateForTest;

async function loadFreshSessionCleanupModules() {
  vi.resetModules();
  vi.doMock("../agents/session-write-lock.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../agents/session-write-lock.js")>();
    return {
      ...original,
      acquireSessionWriteLock: acquireSessionWriteLockMock,
    };
  });
  ({
    withSessionStoreLockForTest,
    getSessionStoreLockQueueSizeForTest,
    clearSessionStoreCacheForTest,
  } = await import("../config/sessions/store.js"));
  ({ cleanupSessionStateForTest } = await import("./session-state-cleanup.js"));
  ({ resetFileLockStateForTest } = await import("../infra/file-lock.js"));
  ({ resetSessionWriteLockStateForTest } = await import("../agents/session-write-lock.js"));
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("cleanupSessionStateForTest", () => {
  beforeEach(async () => {
    await loadFreshSessionCleanupModules();
    vi.useRealTimers();
    clearSessionStoreCacheForTest();
    resetFileLockStateForTest();
    resetSessionWriteLockStateForTest();
    acquireSessionWriteLockMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSessionStoreCacheForTest();
    resetFileLockStateForTest();
    resetSessionWriteLockStateForTest();
    vi.restoreAllMocks();
    vi.doUnmock("../agents/session-write-lock.js");
  });

  it("waits for in-flight session store locks before clearing test state", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-cleanup-"));
    const storePath = path.join(fixtureRoot, "openclaw-sessions.json");
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    let running: Promise<void> | undefined;
    try {
      running = withSessionStoreLockForTest(storePath, async () => {
        started.resolve();
        await release.promise;
      });

      await started.promise;
      expect(getSessionStoreLockQueueSizeForTest()).toBe(1);

      let settled = false;
      const cleanupPromise = cleanupSessionStateForTest().then(() => {
        settled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(settled).toBe(false);

      release.resolve();
      await running;
      await cleanupPromise;

      expect(getSessionStoreLockQueueSizeForTest()).toBe(0);
    } finally {
      release.resolve();
      await running?.catch(() => undefined);
      await cleanupSessionStateForTest();
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
