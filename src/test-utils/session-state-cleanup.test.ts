import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSessionWriteLockStateForTest } from "../agents/session-write-lock.js";
import {
  clearSessionStoreCacheForTest,
  getSessionStoreLockQueueSizeForTest,
  resetSessionStoreLockRuntimeForTests,
  setSessionWriteLockAcquirerForTests,
  withSessionStoreLockForTest,
} from "../config/sessions/store.js";
import { resetFileLockStateForTest } from "../infra/file-lock.js";
import {
  cleanupSessionStateForTest,
  resetSessionStateCleanupRuntimeForTests,
  setSessionStateCleanupRuntimeForTests,
} from "./session-state-cleanup.js";

const acquireSessionWriteLockMock = vi.hoisted(() =>
  vi.fn(async () => ({ release: vi.fn(async () => {}) })),
);
const drainFileLockStateMock = vi.hoisted(() => vi.fn(async () => undefined));
const drainSessionStoreLockQueuesMock = vi.hoisted(() => vi.fn(async () => undefined));
const drainSessionWriteLockStateMock = vi.hoisted(() => vi.fn(async () => undefined));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

describe("cleanupSessionStateForTest", () => {
  beforeEach(() => {
    vi.useRealTimers();
    clearSessionStoreCacheForTest();
    resetFileLockStateForTest();
    resetSessionWriteLockStateForTest();
    acquireSessionWriteLockMock.mockClear();
    drainFileLockStateMock.mockClear();
    drainSessionStoreLockQueuesMock.mockClear();
    drainSessionWriteLockStateMock.mockClear();
    setSessionWriteLockAcquirerForTests(acquireSessionWriteLockMock);
    setSessionStateCleanupRuntimeForTests({
      drainFileLockStateForTest: drainFileLockStateMock,
      drainSessionStoreLockQueuesForTest: drainSessionStoreLockQueuesMock,
      drainSessionWriteLockStateForTest: drainSessionWriteLockStateMock,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSessionStoreCacheForTest();
    resetFileLockStateForTest();
    resetSessionWriteLockStateForTest();
    resetSessionStoreLockRuntimeForTests();
    resetSessionStateCleanupRuntimeForTests();
    vi.restoreAllMocks();
  });

  it("waits for in-flight session store locks before clearing test state", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-cleanup-"));
    const storePath = path.join(fixtureRoot, "openclaw-sessions.json");
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const drainRequested = createDeferred<void>();
    let finishDrain: () => void = () => undefined;
    drainSessionStoreLockQueuesMock.mockImplementationOnce(async () => {
      drainRequested.resolve();
      await new Promise<void>((resolve) => {
        finishDrain = resolve;
      });
    });
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

      await drainRequested.promise;
      await flushMicrotasks();
      expect(settled).toBe(false);
      expect(drainSessionStoreLockQueuesMock).toHaveBeenCalledTimes(1);
      expect(drainFileLockStateMock).not.toHaveBeenCalled();
      expect(drainSessionWriteLockStateMock).not.toHaveBeenCalled();

      release.resolve();
      await running;
      finishDrain();
      await cleanupPromise;

      expect(getSessionStoreLockQueueSizeForTest()).toBe(0);
      expect(drainFileLockStateMock).toHaveBeenCalledTimes(1);
      expect(drainSessionWriteLockStateMock).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      finishDrain();
      await running?.catch(() => undefined);
      await cleanupSessionStateForTest();
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
