import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSessionStoreLockQueueSizeForTest,
  withSessionStoreLockForTest,
} from "../config/sessions/store.js";
import { cleanupSessionStateForTest } from "./session-state-cleanup.js";

const acquireSessionWriteLockMock = vi.hoisted(() =>
  vi.fn(async () => ({ release: vi.fn(async () => {}) })),
);

vi.mock("../agents/session-write-lock.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../agents/session-write-lock.js")>();
  return {
    ...original,
    acquireSessionWriteLock: acquireSessionWriteLockMock,
  };
});

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
  beforeEach(() => {
    acquireSessionWriteLockMock.mockClear();
  });

  afterEach(async () => {
    await cleanupSessionStateForTest();
    vi.restoreAllMocks();
  });

  it("waits for in-flight session store locks before clearing test state", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-cleanup-"));
    const storePath = path.join(fixtureRoot, "openclaw-sessions.json");
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    try {
      const running = withSessionStoreLockForTest(storePath, async () => {
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
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
