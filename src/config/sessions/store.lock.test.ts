import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "./types.js";
import {
  clearSessionStoreCacheForTest,
  getSessionStoreLockQueueSizeForTest,
  loadSessionStore,
  updateSessionStore,
  updateSessionStoreEntry,
  withSessionStoreLockForTest,
} from "../sessions.js";

describe("session store lock (Promise chain mutex)", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let tmpDirs: string[] = [];

  function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  async function waitForFile(filePath: string, maxTicks = 50): Promise<void> {
    for (let tick = 0; tick < maxTicks; tick += 1) {
      try {
        await fs.access(filePath);
        return;
      } catch {
        // Works under both real + fake timers (setImmediate is faked).
        await new Promise<void>((resolve) => process.nextTick(resolve));
      }
    }
    throw new Error(`timed out waiting for file: ${filePath}`);
  }

  async function makeTmpStore(
    initial: Record<string, unknown> = {},
  ): Promise<{ dir: string; storePath: string }> {
    const dir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(dir);
    tmpDirs.push(dir);
    const storePath = path.join(dir, "sessions.json");
    if (Object.keys(initial).length > 0) {
      await fs.writeFile(storePath, JSON.stringify(initial, null, 2), "utf-8");
    }
    return { dir, storePath };
  }

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-test-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  afterEach(async () => {
    clearSessionStoreCacheForTest();
    tmpDirs = [];
  });

  // ── 1. Concurrent access does not corrupt data ──────────────────────

  it("serializes concurrent updateSessionStore calls without data loss", async () => {
    const key = "agent:main:test";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: 100, counter: 0 },
    });

    // Launch 10 concurrent read-modify-write cycles.
    const N = 10;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        updateSessionStore(storePath, async (store) => {
          const entry = store[key] as Record<string, unknown>;
          // Keep an async boundary so stale-read races would surface without serialization.
          await Promise.resolve();
          entry.counter = (entry.counter as number) + 1;
          entry.tag = `writer-${i}`;
        }),
      ),
    );

    const store = loadSessionStore(storePath);
    expect((store[key] as Record<string, unknown>).counter).toBe(N);
  });

  it("concurrent updateSessionStoreEntry patches all merge correctly", async () => {
    const key = "agent:main:merge";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: 100 },
    });

    await Promise.all([
      updateSessionStoreEntry({
        storePath,
        sessionKey: key,
        update: async () => {
          await Promise.resolve();
          return { modelOverride: "model-a" };
        },
      }),
      updateSessionStoreEntry({
        storePath,
        sessionKey: key,
        update: async () => {
          await Promise.resolve();
          return { thinkingLevel: "high" as const };
        },
      }),
      updateSessionStoreEntry({
        storePath,
        sessionKey: key,
        update: async () => {
          await Promise.resolve();
          return { systemPromptOverride: "custom" };
        },
      }),
    ]);

    const store = loadSessionStore(storePath);
    const entry = store[key];
    expect(entry.modelOverride).toBe("model-a");
    expect(entry.thinkingLevel).toBe("high");
    expect(entry.systemPromptOverride).toBe("custom");
  });

  // ── 2. Error in fn() does not break queue ───────────────────────────

  it("continues processing queued tasks after a preceding task throws", async () => {
    const key = "agent:main:err";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: 100 },
    });

    const errorPromise = updateSessionStore(storePath, async () => {
      throw new Error("boom");
    });

    // Queue a second write immediately after the failing one.
    const successPromise = updateSessionStore(storePath, async (store) => {
      store[key] = { ...store[key], modelOverride: "after-error" } as unknown as SessionEntry;
    });

    await expect(errorPromise).rejects.toThrow("boom");
    await successPromise; // must resolve, not hang or reject

    const store = loadSessionStore(storePath);
    expect(store[key]?.modelOverride).toBe("after-error");
  });

  it("multiple consecutive errors do not permanently poison the queue", async () => {
    const key = "agent:main:multi-err";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: 100 },
    });

    const errors = Array.from({ length: 3 }, (_, i) =>
      updateSessionStore(storePath, async () => {
        throw new Error(`fail-${i}`);
      }),
    );

    const success = updateSessionStore(storePath, async (store) => {
      store[key] = { ...store[key], modelOverride: "recovered" } as unknown as SessionEntry;
    });

    // All error promises reject.
    for (const p of errors) {
      await expect(p).rejects.toThrow();
    }
    // The trailing write succeeds.
    await success;

    const store = loadSessionStore(storePath);
    expect(store[key]?.modelOverride).toBe("recovered");
  });

  // ── 3. Different storePaths run independently / in parallel ─────────

  it("operations on different storePaths execute concurrently", async () => {
    const { storePath: pathA } = await makeTmpStore({
      a: { sessionId: "a", updatedAt: 100 },
    });
    const { storePath: pathB } = await makeTmpStore({
      b: { sessionId: "b", updatedAt: 100 },
    });

    const order: string[] = [];
    let started = 0;
    let releaseBoth: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const markStarted = () => {
      started += 1;
      if (started === 2) {
        releaseBoth?.();
      }
    };

    const opA = updateSessionStore(pathA, async (store) => {
      order.push("a-start");
      markStarted();
      await gate;
      store.a = { ...store.a, modelOverride: "done-a" } as unknown as SessionEntry;
      order.push("a-end");
    });

    const opB = updateSessionStore(pathB, async (store) => {
      order.push("b-start");
      markStarted();
      await gate;
      store.b = { ...store.b, modelOverride: "done-b" } as unknown as SessionEntry;
      order.push("b-end");
    });

    await Promise.all([opA, opB]);

    // Parallel behavior: both ops start before either one finishes.
    const aStart = order.indexOf("a-start");
    const bStart = order.indexOf("b-start");
    const aEnd = order.indexOf("a-end");
    const bEnd = order.indexOf("b-end");
    const firstEnd = Math.min(aEnd, bEnd);
    expect(aStart).toBeGreaterThanOrEqual(0);
    expect(bStart).toBeGreaterThanOrEqual(0);
    expect(aEnd).toBeGreaterThanOrEqual(0);
    expect(bEnd).toBeGreaterThanOrEqual(0);
    expect(aStart).toBeLessThan(firstEnd);
    expect(bStart).toBeLessThan(firstEnd);

    expect(loadSessionStore(pathA).a?.modelOverride).toBe("done-a");
    expect(loadSessionStore(pathB).b?.modelOverride).toBe("done-b");
  });

  // ── 4. LOCK_QUEUES cleanup ─────────────────────────────────────────

  it("cleans up LOCK_QUEUES entry after all tasks complete", async () => {
    const { storePath } = await makeTmpStore({
      x: { sessionId: "x", updatedAt: 100 },
    });

    await updateSessionStore(storePath, async (store) => {
      store.x = { ...store.x, modelOverride: "done" } as unknown as SessionEntry;
    });

    // Allow microtask (finally) to run.
    await Promise.resolve();

    expect(getSessionStoreLockQueueSizeForTest()).toBe(0);
  });

  it("cleans up LOCK_QUEUES entry even after errors", async () => {
    const { storePath } = await makeTmpStore({});

    await updateSessionStore(storePath, async () => {
      throw new Error("fail");
    }).catch(() => undefined);

    await Promise.resolve();

    expect(getSessionStoreLockQueueSizeForTest()).toBe(0);
  });

  // ── 5. FIFO order guarantee ──────────────────────────────────────────

  it("executes queued operations in FIFO order", async () => {
    const key = "agent:main:fifo";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: 100, order: "" },
    });

    const executionOrder: number[] = [];

    // Queue 5 operations sequentially (no awaiting in between).
    const promises = Array.from({ length: 5 }, (_, i) =>
      updateSessionStore(storePath, async (store) => {
        executionOrder.push(i);
        const entry = store[key] as Record<string, unknown>;
        entry.order = ((entry.order as string) || "") + String(i);
      }),
    );

    await Promise.all(promises);

    // Execution order must be 0, 1, 2, 3, 4 (FIFO).
    expect(executionOrder).toEqual([0, 1, 2, 3, 4]);

    // The store should reflect sequential application.
    const store = loadSessionStore(storePath);
    expect((store[key] as Record<string, unknown>).order).toBe("01234");
  });

  it("times out queued operations strictly and does not run them later", async () => {
    vi.useFakeTimers();
    try {
      const { storePath } = await makeTmpStore({
        x: { sessionId: "x", updatedAt: 100 },
      });
      let timedOutRan = false;

      const lockPath = `${storePath}.lock`;
      const releaseLock = createDeferred<void>();
      const lockHolder = withSessionStoreLockForTest(
        storePath,
        async () => {
          await releaseLock.promise;
        },
        { timeoutMs: 1_000 },
      );
      await waitForFile(lockPath);
      const timedOut = withSessionStoreLockForTest(
        storePath,
        async () => {
          timedOutRan = true;
        },
        { timeoutMs: 5 },
      );

      // Attach rejection handler before advancing fake timers to avoid unhandled rejections.
      const timedOutExpectation = expect(timedOut).rejects.toThrow(
        "timeout waiting for session store lock",
      );
      await vi.advanceTimersByTimeAsync(5);
      await timedOutExpectation;
      releaseLock.resolve();
      await lockHolder;
      await vi.runOnlyPendingTimersAsync();
      expect(timedOutRan).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates and removes lock file while operation runs", async () => {
    const key = "agent:main:no-lock-file";
    const { dir, storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: 100 },
    });

    const lockPath = `${storePath}.lock`;
    const allowWrite = createDeferred<void>();
    const write = updateSessionStore(storePath, async (store) => {
      await allowWrite.promise;
      store[key] = { ...store[key], modelOverride: "v" } as unknown as SessionEntry;
    });

    await waitForFile(lockPath);
    allowWrite.resolve();
    await write;

    const files = await fs.readdir(dir);
    const lockFiles = files.filter((f) => f.endsWith(".lock"));
    expect(lockFiles).toHaveLength(0);
  });
});
