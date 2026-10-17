import { channel as diagnosticsChannel } from "node:diagnostics_channel";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { MessagePort } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { runQueuedStoreWrite } from "../shared/store-writer-queue.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../state/openclaw-agent-write-admission-state.js";
import { closeWorkerTaskPoolResources } from "./worker-task-pool-registry.js";
import { createOwnedWorkerTaskPool } from "./worker-task-pool.js";
import {
  holdExit,
  reply,
  request,
  type FakeWorker,
} from "./worker-task-pool.owned.test-support.js";

const workers = vi.hoisted(() => [] as FakeWorker[]);
const messageChannelReceivers = vi.hoisted(() => new WeakMap<MessagePort, MessagePort>());

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 3,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { createMockWorkerClass } = await import("./worker-task-pool.owned.test-support.js");
  return {
    ...actual,
    MessageChannel: class extends actual.MessageChannel {
      constructor() {
        super();
        messageChannelReceivers.set(this.port2, this.port1);
      }
    },
    Worker: createMockWorkerClass(workers),
  };
});
vi.mock("./runtime-worker-url.js", () => ({ resolveRuntimeWorkerThreadExecArgv: () => [] }));

type Pool = ReturnType<typeof createOwnedWorkerTaskPool<string, string>>;
type PoolOptions = Parameters<typeof createOwnedWorkerTaskPool<string, string>>[0];
const pools: Pool[] = [];

function createPool(options: Partial<PoolOptions> = {}) {
  const pool = createOwnedWorkerTaskPool<string, string>({
    workerUrl: new URL("file:///fixture/owned-worker.js"),
    maxWorkers: 1,
    idleTimeoutMs: 0,
    ...options,
  });
  pools.push(pool);
  return pool;
}

function workerFor(input: string): FakeWorker {
  return expectDefined(
    workers.find((worker) => worker.posted.mock.calls.some(([task]) => task.input === input)),
    `worker for ${input}`,
  );
}

async function completedWorker(pool: Pool) {
  const task = pool.runTask("read", {});
  await nextTurn();
  const worker = workerFor("read");
  await finishTask(task, "read");
  return worker;
}

async function finishTask(task: ReturnType<Pool["runTask"]>, input: string) {
  reply(workerFor(input), input);
  await expect(task.result).resolves.toBe(input);
  await task.close();
}

function cleanupReceipt(worker: FakeWorker) {
  return expectDefined(worker.posted.mock.calls.at(-1)?.[0].resourcePort, "cleanup receipt");
}

function trackedTask(
  pool: Pool,
  input: Parameters<Pool["runTask"]>[0],
  options: Parameters<Pool["runTask"]>[1] = {},
) {
  const consumed = vi.fn();
  const settled = vi.fn();
  return {
    ...pool.runTask(input, { ...options, onInputConsumed: consumed, onExecutionSettled: settled }),
    expectHeld() {
      expect(consumed).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
    },
    expectReleased(retired: boolean) {
      expect(consumed).toHaveBeenCalledOnce();
      expect(settled).toHaveBeenCalledExactlyOnceWith({ retired });
    },
  };
}

function acknowledgeCleanup(receipt: MessagePort, error?: string) {
  receipt.postMessage(error ? { ok: false, error } : { ok: true }, []);
  receipt.close();
}

beforeEach(() => workers.splice(0));
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  vi.useRealTimers();
});

it("retires burst workers without extending the first worker's idle lifetime", async () => {
  vi.useFakeTimers();
  const pool = createPool({ maxWorkers: 2, idleTimeoutMs: 60_000, burstIdleTimeoutMs: 5_000 });
  const first = pool.run("first", {});
  const burst = pool.run("burst", {});
  const primary = workerFor("first");
  const surplus = workerFor("burst");
  reply(primary, "first");
  reply(surplus, "burst");
  await Promise.all([first, burst]);

  await vi.advanceTimersByTimeAsync(5_000);
  expect(surplus.terminate).toHaveBeenCalledOnce();
  expect(primary.terminate).not.toHaveBeenCalled();
  expect(pool.getSnapshot().workers).toBe(1);

  const reused = pool.run("reused", {});
  expect(workerFor("reused")).toBe(primary);
  reply(primary, "reused");
  await reused;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(primary.terminate).toHaveBeenCalledOnce();
  expect(pool.getSnapshot().workers).toBe(0);
});

it("keeps the remaining worker's original idle deadline while the first worker stops", async () => {
  vi.useFakeTimers();
  const pool = createPool({ maxWorkers: 2, idleTimeoutMs: 60_000, burstIdleTimeoutMs: 5_000 });
  const controller = new AbortController();
  const first = pool.run("first", { signal: controller.signal });
  const native = holdExit(workerFor("first"));
  const cancellation = expect(first).rejects.toThrow("cancel first");
  try {
    const burst = pool.run("burst", {});
    const survivor = workerFor("burst");
    reply(survivor, "burst");
    await burst;
    controller.abort(new Error("cancel first"));
    await native.entered;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(survivor.terminate).not.toHaveBeenCalled();
    expect(pool.getSnapshot().workers).toBe(2);
    native.release();
    await cancellation;
    expect(pool.getSnapshot().workers).toBe(1);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(survivor.terminate).toHaveBeenCalledOnce();
    expect(pool.getSnapshot().workers).toBe(0);
  } finally {
    native.release();
    await pool.close();
    await cancellation;
  }
});

it("guards process-wide reader cleanup before dispatching to registered pools", async () => {
  createPool();
  await runQueuedStoreWrite({
    queues: SQLITE_SESSION_WRITER_QUEUES,
    storePath: "synthetic-reader-store",
    label: "reader cleanup guard",
    fn: async () => {
      expect(() => closeWorkerTaskPoolResources("synthetic-reader-store")).toThrow(
        "while holding a store writer",
      );
    },
  });
  await expect(closeWorkerTaskPoolResources("synthetic-reader-store")).resolves.toBeUndefined();
  await runQueuedStoreWrite({
    queues: new Map(),
    storePath: "synthetic-reader-store",
    label: "logical lifecycle owner",
    fn: () => closeWorkerTaskPoolResources("synthetic-reader-store"),
  });
});

it("retires only idle slots on critical pressure, after result and resource custody settle", async () => {
  const pool = createPool({ idleTimeoutMs: 30 * 60_000 });
  const pressure = diagnosticsChannel("openclaw.memory.critical");
  const task = pool.runTask("read", {});
  const worker = workerFor("read");
  pressure.publish(undefined);
  reply(worker, "read");
  await task.result;
  pressure.publish(undefined);
  expect(worker.terminate).not.toHaveBeenCalled();
  await task.close();
  const cleanup = pool.closeResources("source");
  pressure.publish(undefined);
  expect(worker.terminate).not.toHaveBeenCalled();
  acknowledgeCleanup(cleanupReceipt(worker));
  await cleanup;
  pressure.publish(undefined);
  await nextTurn();
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(pool.getSnapshot().workers).toBe(0);
  const next = pool.runTask("next", {});
  const replacement = workerFor("next");
  expect(replacement).not.toBe(worker);
  await finishTask(next, "next");
});

it("reaches a cooperative exchange when earlier shared pressure has not released capacity", async () => {
  const blocked = createPool({ sharedCompute: true });
  const cooperative = createPool({ sharedCompute: true });
  const waiting = createPool({ sharedCompute: true });
  const blockedEntered = createDeferredCore<AbortSignal>();
  const cooperativeEntered = createDeferredCore<AbortSignal>();
  const unblock = createDeferredCore();
  const checkpoint = createDeferredCore();
  const blockedTask = blocked.run("blocked", {
    onRequest: async (_value, { yieldSignal }) => {
      blockedEntered.resolve(yieldSignal);
      await unblock.promise;
      return { input: "continue", timeoutMs: 1_000 };
    },
  });
  const cooperativeTask = cooperative.run("cooperative", {
    onRequest: async (_value, { yieldSignal }) => {
      cooperativeEntered.resolve(yieldSignal);
      yieldSignal.addEventListener("abort", () => checkpoint.resolve(), { once: true });
      await checkpoint.promise;
      return { input: "checkpoint", timeoutMs: 1_000 };
    },
  });
  const running = Promise.allSettled([blockedTask, cooperativeTask]);
  const cooperativeWorker = workerFor("cooperative");
  cooperativeWorker.posted.mockImplementation((message) => {
    if (message.responseId !== undefined) {
      queueMicrotask(() => {
        cooperativeWorker.emit("message", {
          status: "consumed",
          taskId: message.taskId,
          id: message.responseId,
        });
        reply(cooperativeWorker, "cooperative");
      });
    }
  });
  for (const input of ["blocked", "cooperative"]) {
    request(workerFor(input), input);
  }
  const [blockedSignal, cooperativeSignal] = await Promise.all([
    blockedEntered.promise,
    cooperativeEntered.promise,
  ]);
  const prepared: string[] = [];
  const next = waiting.run(() => {
    prepared.push("next");
    return "next";
  }, {});
  const nextOutcome = Promise.allSettled([next]);
  let queued: Promise<PromiseSettledResult<string>[]> | undefined;
  try {
    expect(blockedSignal.aborted).toBe(true);
    expect(cooperativeSignal.aborted).toBe(false);
    expect(prepared).toEqual([]);
    const later = waiting.run(() => {
      prepared.push("later");
      return "later";
    }, {});
    queued = Promise.allSettled([later]);
    expect(cooperativeSignal.aborted).toBe(true);
    await expect(cooperativeTask).resolves.toBe("cooperative");
    expect(prepared).toEqual(["next"]);
    expect(blocked.getSnapshot().activeTasks).toBe(1);
    reply(workerFor("next"), "next");
    await expect(next).resolves.toBe("next");
    expect(prepared).toEqual(["next", "later"]);
    reply(workerFor("later"), "later");
    await expect(later).resolves.toBe("later");
  } finally {
    unblock.resolve();
    checkpoint.resolve();
    await Promise.all([blocked.close(), cooperative.close(), waiting.close()]);
    await Promise.all([running, nextOutcome, queued]);
  }
});

it.each([false, true])(
  "joins an existing retirement when the cleanup port closes before native exit (retirement fails=%s)",
  async (fails) => {
    const pool = createPool();
    const worker = await completedWorker(pool);
    const listeners = worker.listenerCount("exit");
    const cleanup = pool.closeResources("source");
    const cleanupSettled = vi.fn();
    void cleanup.then(cleanupSettled, cleanupSettled);
    const receipt = cleanupReceipt(worker);
    const receiver = expectDefined(messageChannelReceivers.get(receipt), "cleanup receiver");
    const portClosed = createDeferredCore();
    receiver.once("close", portClosed.resolve);
    const native = holdExit(worker);
    const rotation = pool.rotate();
    void rotation.catch(() => {});
    try {
      await native.entered;
      receipt.close();
      await portClosed.promise;
      await nextTurn();
      expect(cleanupSettled).not.toHaveBeenCalled();
      expect(worker.listenerCount("exit")).toBe(listeners + 1);
      expect(worker.terminate).toHaveBeenCalledOnce();
      if (fails) {
        const failure = new Error("native retirement did not settle");
        const cleanupFailed = expect(cleanup).rejects.toMatchObject({ errors: [failure] });
        const retirementFailed = expect(rotation).rejects.toBe(failure);
        native.reject(failure);
        await Promise.all([cleanupFailed, retirementFailed]);
        expect(worker.listenerCount("exit")).toBe(listeners);
      } else {
        native.release();
        await Promise.all([cleanup, rotation]);
        expect(worker.listenerCount("exit")).toBe(0);
      }
    } finally {
      native.release();
      await Promise.allSettled([cleanup, rotation]);
    }
  },
);

it.each(["receipts", "exit"] as const)(
  "bounds concurrent cleanup listeners until every receipt or native exit settles (%s)",
  async (settlement) => {
    const pool = createPool();
    const worker = await completedWorker(pool);
    const listeners = worker.listenerCount("exit");
    const cleanups = Array.from({ length: 32 }, (_, index) =>
      pool.closeResources(`source-${index}`),
    );
    const results = Promise.allSettled(cleanups);
    const receipts = worker.posted.mock.calls
      .slice(-cleanups.length)
      .map(([message]) => expectDefined(message.resourcePort, "cleanup receipt"));
    expect(worker.listenerCount("exit")).toBe(listeners + 1);
    for (const [index, receipt] of receipts.slice(0, 16).entries()) {
      acknowledgeCleanup(receipt, index === 0 ? "synthetic close failure" : undefined);
    }
    const partial = await Promise.allSettled(cleanups.slice(0, 16));
    expect(partial.filter((result) => result.status === "fulfilled")).toHaveLength(15);
    expect(partial[0]).toMatchObject({
      status: "rejected",
      reason: { message: "Worker resource cleanup failed" },
    });
    expect(worker.listenerCount("exit")).toBe(listeners + 1);
    if (settlement === "exit") {
      // Native exit still proves cleanup when the remaining receipts never arrive.
      await pool.close();
    } else {
      for (const receipt of receipts.slice(16)) {
        acknowledgeCleanup(receipt);
      }
    }
    expect((await results).filter((result) => result.status === "fulfilled")).toHaveLength(31);
    expect(worker.listenerCount("exit")).toBe(settlement === "exit" ? 0 : listeners);
    if (settlement === "receipts") {
      expect(worker.terminate).not.toHaveBeenCalled();
    }
  },
);

it("holds a completed reply until acceptance and never retires its successor on late close", async () => {
  const pool = createPool();
  const order: string[] = [];
  const executionSettled = vi.fn(({ retired }: { retired: boolean }) => {
    order.push(`settled:${retired}`);
  });
  const options = Object.freeze({ onExecutionSettled: executionSettled });
  const first = pool.runTask("first", options);
  const worker = workerFor("first");
  const prepareNext = vi.fn(() => {
    order.push("successor");
    return "next";
  });
  const next = pool.runTask(prepareNext, options);
  void next.result.catch(() => {});

  reply(worker, "first", "accepted reply");
  await expect(first.result).resolves.toBe("accepted reply");
  expect(order).toEqual([]);
  expect(worker.posted).toHaveBeenCalledOnce();
  expect(pool.getSnapshot().pendingTasks).toBe(2);

  await first.close();
  expect(executionSettled).toHaveBeenCalledExactlyOnceWith({ retired: false });
  expect(order).toEqual(["settled:false", "successor"]);
  expect(workerFor("next")).toBe(worker);
  await first.close({ retire: true });
  await first.close();
  expect(worker.terminate).not.toHaveBeenCalled();
  await finishTask(next, "next");
  expect(order).toEqual(["settled:false", "successor", "settled:false"]);
  expect(options.onExecutionSettled).toBe(executionSettled);
  expect(pool.getSnapshot().pendingTasks).toBe(0);
});

it("cancels a queued task without preparing its input or stopping the occupied worker", async () => {
  const pool = createPool();
  const active = pool.runTask("active", {});
  void active.result.catch(() => {});
  const worker = workerFor("active");
  const controller = new AbortController();
  const reason = new Error("queued owner closed");
  const prepare = vi.fn(() => "must not dispatch");
  const queued = trackedTask(pool, prepare, { signal: controller.signal });
  const rejected = expect(queued.result).rejects.toBe(reason);
  controller.abort(reason);
  await rejected;
  await queued.close();

  expect(prepare).not.toHaveBeenCalled();
  queued.expectReleased(false);
  expect(worker.terminate).not.toHaveBeenCalled();
  expect(worker.posted).toHaveBeenCalledOnce();
  await finishTask(active, "active");
});

it("joins cancelled asynchronous preparation before releasing input custody", async () => {
  const pool = createPool({ maxPendingBytes: 8 });
  const preparing = createDeferredCore();
  const prepared = createDeferredCore<string>();
  const controller = new AbortController();
  const reason = new Error("preparation owner closed");
  const task = trackedTask(
    pool,
    async () => {
      preparing.resolve();
      return await prepared.promise;
    },
    {
      inputBytes: 8,
      signal: controller.signal,
    },
  );
  await preparing.promise;
  const rejected = expect(task.result).rejects.toBe(reason);
  controller.abort(reason);
  const closed = vi.fn();
  const closing = task.close().then(closed);
  try {
    await rejected;
    expect(closed).not.toHaveBeenCalled();
    task.expectHeld();
    expect(pool.getSnapshot().pendingTasks).toBe(1);
    expect(workers).toHaveLength(0);
  } finally {
    prepared.resolve("must not dispatch");
    await closing;
  }
  expect(closed).toHaveBeenCalledOnce();
  task.expectReleased(true);
  expect(pool.getSnapshot().pendingTasks).toBe(0);
  expect(workers).toHaveLength(0);
});

it.each(["message", "error", "exit"] as const)(
  "retains failed retirement custody until explicit close despite a late %s event",
  async (lateEvent) => {
    const primary = new Error("result rejected by its owner");
    const cleanup = new Error("native exit not confirmed");
    const retirementFailed = createDeferredCore();
    const pool = createPool({
      maxWorkers: 2,
      maxPendingBytes: 10,
      validateResult(value) {
        if (value === "invalid") {
          throw primary;
        }
      },
      onRetirementFailure: () => retirementFailed.resolve(),
    });
    const failed = trackedTask(pool, "failed", { inputBytes: 8 });
    const sibling = pool.runTask("sibling", { inputBytes: 1 });
    const worker = workerFor("failed");
    const siblingWorker = workerFor("sibling");
    const expectRetained = () => {
      failed.expectHeld();
      expect(pool.getSnapshot().pendingTasks).toBe(2);
      expect(siblingWorker.terminate).not.toHaveBeenCalled();
      expect(worker.terminate).toHaveBeenCalledOnce();
    };
    worker.terminate.mockRejectedValueOnce(cleanup);
    const rejected = expect(failed.result).rejects.toBe(primary);
    reply(worker, "failed", "invalid");
    await rejected;
    await retirementFailed.promise;
    // Both the cached owner failure and the slot retirement rejection must have settled.
    await nextTurn();
    const emitLateEvent = {
      message: () => reply(worker, "failed", "late reply from the same task"),
      error: () => worker.emit("error", new Error("late worker error")),
      exit: () => worker.emit("exit", 1),
    }[lateEvent];
    emitLateEvent();
    await nextTurn();
    expectRetained();
    await expect(failed.result).rejects.toBe(primary);
    await expect(failed.close()).rejects.toBe(cleanup);
    // Observing the failure permits an explicit retry, never a retry from a late event.
    emitLateEvent();
    await nextTurn();
    expectRetained();
    await expect(failed.result).rejects.toBe(primary);
    const excess = pool.runTask("over capacity", { inputBytes: 2 });
    await expect(excess.result).rejects.toMatchObject({ code: "overloaded" });
    await excess.close();

    await finishTask(sibling, "sibling");
    const native = holdExit(worker);
    const closing = failed.close();
    const alsoClosing = failed.close();
    try {
      await native.entered;
      failed.expectHeld();
      const next = pool.runTask("sibling successor", { inputBytes: 2 });
      expect(workerFor("sibling successor")).toBe(siblingWorker);
      expect(workers).toHaveLength(2);
      await finishTask(next, "sibling successor");
      expect(siblingWorker.terminate).not.toHaveBeenCalled();
    } finally {
      native.release();
      await Promise.all([closing, alsoClosing]);
    }
    expect(worker.terminate).toHaveBeenCalledTimes(2);
    failed.expectReleased(true);
    expect(pool.getSnapshot().pendingTasks).toBe(0);
    await expect(failed.result).rejects.toBe(primary);
    await failed.close({ retire: true });
    failed.expectReleased(true);
    expect(worker.terminate).toHaveBeenCalledTimes(2);
  },
);

it("observes each failed stop once before a global close retries an owned task", async () => {
  const primary = new Error("original task failure");
  const firstStop = new Error("automatic stop failed");
  const secondStop = new Error("explicit retry failed");
  const automaticFailure = createDeferredCore();
  const pool = createPool({
    maxPendingBytes: 8,
    validateResult() {
      throw primary;
    },
    onRetirementFailure(error) {
      if (error === firstStop) {
        // Let automatic retirement finish caching its rejection before close observes it.
        setImmediate(() => automaticFailure.resolve());
      }
    },
  });
  const consumed = vi.fn();
  const task = pool.runTask("failed", { inputBytes: 8, onInputConsumed: consumed });
  const worker = workerFor("failed");
  const expectHeld = (attempts: number) => {
    expect(worker.terminate).toHaveBeenCalledTimes(attempts);
    expect(consumed).not.toHaveBeenCalled();
    expect(pool.getSnapshot().pendingTasks).toBe(1);
  };
  worker.terminate.mockRejectedValueOnce(firstStop).mockRejectedValueOnce(secondStop);
  const native = holdExit(worker);
  const rejected = expect(task.result).rejects.toBe(primary);
  reply(worker, "failed");
  try {
    await rejected;
    await automaticFailure.promise;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(consumed).not.toHaveBeenCalled();
    const excess = pool.runTask("capacity remains held", { inputBytes: 1 });
    await expect(excess.result).rejects.toMatchObject({ code: "overloaded" });
    await excess.close();

    await expect(pool.close()).rejects.toBe(firstStop);
    expectHeld(1);

    const resources = closeWorkerTaskPoolResources("retained-after-failed-close");
    acknowledgeCleanup(cleanupReceipt(worker));
    await resources;

    await expect(pool.close()).rejects.toBe(secondStop);
    expectHeld(2);
    await expect(task.result).rejects.toBe(primary);

    const closing = pool.close();
    await native.entered;
    expectHeld(3);
    const resourcesClosed = vi.fn();
    const closingResources = closeWorkerTaskPoolResources("closing-pool").then(resourcesClosed);
    await nextTurn();
    expect(resourcesClosed).not.toHaveBeenCalled();
    native.release();
    await closing;
    await closingResources;
    expect(consumed).toHaveBeenCalledOnce();
    expect(pool.getSnapshot().pendingTasks).toBe(0);
    await expect(task.result).rejects.toBe(primary);
    await Promise.all([task.close(), pool.close()]);
    expect(worker.terminate).toHaveBeenCalledTimes(3);
  } finally {
    native.release();
  }
});

it("joins native exit when global close reenters healthy task completion", async () => {
  const pool = createPool();
  const task = pool.runTask("completed", {});
  const worker = workerFor("completed");
  reply(worker, "completed", "accepted reply");
  await expect(task.result).resolves.toBe("accepted reply");
  const native = holdExit(worker);
  const diagnostics = diagnosticsChannel("openclaw.worker.task");
  let globalClose: Promise<void> | undefined;
  const globallyClosed = vi.fn();
  let completions = 0;
  const onCompletion = (message: unknown) => {
    if (
      !message ||
      typeof message !== "object" ||
      !("worker" in message) ||
      message.worker !== "owned-worker.js"
    ) {
      return;
    }
    completions++;
    globalClose ??= pool.close().then(globallyClosed);
  };
  diagnostics.subscribe(onCompletion);
  const closingTask = task.close();
  try {
    await closingTask;
    // A healthy task is detached before its completion observer reenters pool.close().
    await nextTurn();
    expect(completions).toBe(1);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(globallyClosed).not.toHaveBeenCalled();
    await expect(task.result).resolves.toBe("accepted reply");
  } finally {
    diagnostics.unsubscribe(onCompletion);
    native.release();
    await closingTask;
    await globalClose;
  }
  expect(globallyClosed).toHaveBeenCalledOnce();
  await Promise.all([task.close(), pool.close()]);
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(completions).toBe(1);
  expect(pool.getSnapshot().pendingTasks).toBe(0);
  await expect(task.result).resolves.toBe("accepted reply");
});

it.each(["task-first", "pool-first"] as const)(
  "joins one native stop when global and task close overlap (%s)",
  async (order) => {
    const pool = createPool();
    const consumed = vi.fn();
    const task = pool.runTask("active", { onInputConsumed: consumed });
    const worker = workerFor("active");
    const native = holdExit(worker);
    const rejected = expect(task.result).rejects.toBeInstanceOf(Error);
    const closing =
      order === "task-first" ? [task.close(), pool.close()] : [pool.close(), task.close()];
    try {
      await rejected;
      await native.entered;
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(consumed).not.toHaveBeenCalled();
    } finally {
      native.release();
      await Promise.all(closing);
    }
    expect(consumed).toHaveBeenCalledOnce();
    expect(pool.getSnapshot().pendingTasks).toBe(0);
    await Promise.all([task.close(), pool.close()]);
    expect(worker.terminate).toHaveBeenCalledOnce();
  },
);
