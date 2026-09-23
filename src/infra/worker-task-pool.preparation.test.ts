import { AsyncLocalStorage } from "node:async_hooks";
import type { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

type PostedTask = { input: string; taskId: number };
type FakeWorker = EventEmitter & {
  postMessage: ReturnType<typeof vi.fn<(message: PostedTask) => void>>;
  terminate: ReturnType<typeof vi.fn<() => Promise<number>>>;
};
const workers = vi.hoisted(() => [] as FakeWorker[]);
vi.mock("node:os", () => ({ availableParallelism: () => 2 }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    Worker: class extends EventEmitter {
      constructor() {
        super();
        workers.push(this);
      }
      postMessage = vi.fn((message: PostedTask) => {
        queueMicrotask(() =>
          this.emit("message", { status: "ok", taskId: message.taskId, value: message.input }),
        );
      });
      ref() {}
      unref() {}
      terminate = vi.fn(async () => {
        this.emit("exit", 0);
        return 0;
      });
    },
  };
});
vi.mock("./runtime-worker-url.js", () => ({ resolveRuntimeWorkerThreadExecArgv: () => [] }));

const pools: WorkerTaskPool<string, string>[] = [];
function createPool(
  options: { sharedCompute?: boolean; maxPendingBytes?: number; maxPendingTasks?: number } = {},
) {
  const pool = new WorkerTaskPool<string, string>({
    workerUrl: new URL("file:///fixture/preparation-worker.js"),
    maxWorkers: 1,
    idleTimeoutMs: 0,
    ...options,
  });
  pools.push(pool);
  return pool;
}
beforeEach(() => workers.splice(0));
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

describe("public worker task preparation custody", () => {
  it("releases a rejected factory before its caller catches and immediately retries", async () => {
    const pool = createPool({ maxPendingTasks: 1 });
    await pool.run("warm", {});
    const worker = workers[0]!;
    const reason = new Error("factory rejected before dispatch");
    const consumed = vi.fn();
    const retried = pool
      .run(
        async () => {
          throw reason;
        },
        { onInputConsumed: consumed },
      )
      .catch((error: unknown) => {
        expect(error).toBe(reason);
        expect(consumed).toHaveBeenCalledOnce();
        expect(pool.getSnapshot().pendingTasks).toBe(0);
        return pool.run("immediate retry", {});
      });
    await expect(retried).resolves.toBe("immediate retry");
    expect(workers).toHaveLength(1);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(worker.postMessage.mock.calls.map(([message]) => message.input)).toEqual([
      "warm",
      "immediate retry",
    ]);
  });

  it.each([
    { order: "preparation-first", rejects: false },
    { order: "preparation-first", rejects: true },
    { order: "exit-first", rejects: false },
    { order: "exit-first", rejects: true },
  ])(
    "joins both lifetimes before releasing input ($order, rejects=$rejects)",
    async ({ order, rejects }) => {
      const pool = createPool({ sharedCompute: true, maxPendingBytes: 8 });
      await expect(pool.run("warm", {})).resolves.toBe("warm");
      const worker = workers[0]!;
      const exit = createDeferredCore();
      const stopping = createDeferredCore();
      worker.terminate.mockImplementationOnce(async () => {
        stopping.resolve();
        await exit.promise;
        worker.emit("exit", 0);
        return 0;
      });
      const preparation = createDeferredCore();
      const captured = ["retained request"];
      let observed: string[] | undefined;
      const context = new AsyncLocalStorage<string>();
      const consumed = vi.fn(() => {
        expect(context.getStore()).toBe("input owner");
        captured.length = 0;
      });
      const executionSettled = vi.fn(() => {
        expect(context.getStore()).toBe("input owner");
      });
      const controller = new AbortController();
      const reason = new Error("preparation canceled");
      const active = context.run("input owner", () =>
        pool.run(
          async () => {
            await preparation.promise;
            observed = [...captured];
            if (rejects) {
              throw new Error("late preparation failure");
            }
            return captured.join(",");
          },
          {
            signal: controller.signal,
            inputBytes: 8,
            onInputConsumed: consumed,
            onExecutionSettled: executionSettled,
          },
        ),
      );
      const rejected = expect(active).rejects.toBe(reason);
      const waiting = createPool({ sharedCompute: true });
      const contender = vi.fn(() => "next pool");
      const next = waiting.run(contender, {});
      const rotation = pool.rotate();
      controller.abort(reason);
      try {
        await stopping.promise;
        expect(captured).toEqual(["retained request"]);
        expect(pool.getSnapshot().pendingTasks).toBe(1);
        await expect(pool.run("over capacity", { inputBytes: 1 })).rejects.toMatchObject({
          code: "overloaded",
        });
        if (order === "exit-first") {
          exit.resolve();
          await rejected;
          expect(executionSettled).toHaveBeenCalledExactlyOnceWith({ retired: true });
          await rotation;
        } else {
          preparation.resolve();
          await nextTurn();
          expect(observed).toEqual(["retained request"]);
          expect(executionSettled).not.toHaveBeenCalled();
        }
        expect(captured).toEqual(["retained request"]);
        expect(consumed).not.toHaveBeenCalled();
        expect(contender).not.toHaveBeenCalled();
        expect(pool.getSnapshot().pendingTasks).toBe(1);
        let closed = false;
        const closing = pool.close().then(() => {
          closed = true;
        });
        await nextTurn();
        expect(closed).toBe(false);
        preparation.resolve();
        exit.resolve();
        await Promise.all([closing, rotation, rejected]);
        await expect(next).resolves.toBe("next pool");
        expect(observed).toEqual(["retained request"]);
        expect(captured).toEqual([]);
        expect(consumed).toHaveBeenCalledOnce();
        expect(executionSettled).toHaveBeenCalledExactlyOnceWith({ retired: true });
        expect(worker.postMessage.mock.calls.map(([message]) => message.input)).toEqual(["warm"]);
        expect(pool.getSnapshot().pendingTasks).toBe(0);
        await expect(active).rejects.toBe(reason);
      } finally {
        preparation.resolve();
        exit.resolve();
        await rejected;
        await Promise.allSettled([active, next, rotation, pool.close()]);
      }
    },
  );

  it("retains preparation custody across failed mocked stops until the same worker exits", async () => {
    const pool = createPool({ sharedCompute: true, maxPendingBytes: 8 });
    await pool.run("warm", {});
    const worker = workers[0]!;
    const firstFailure = new Error("automatic stop failed");
    const retryFailure = new Error("explicit stop failed");
    worker.terminate.mockRejectedValueOnce(firstFailure).mockRejectedValueOnce(retryFailure);
    const preparation = createDeferredCore();
    const captured = ["retained request"];
    let observed: string[] | undefined;
    const consumed = vi.fn(() => {
      captured.length = 0;
    });
    const controller = new AbortController();
    const reason = new Error("canceled during preparation");
    const active = pool.run(
      async () => {
        await preparation.promise;
        observed = [...captured];
        return captured.join(",");
      },
      { signal: controller.signal, inputBytes: 8, onInputConsumed: consumed },
    );
    const outcome = active.catch((error: unknown) => error);
    const waiting = createPool({ sharedCompute: true });
    const contender = vi.fn(() => "next pool");
    const next = waiting.run(contender, {});
    controller.abort(reason);
    try {
      const originalFailure = await outcome;
      expect(originalFailure).toMatchObject({
        cause: firstFailure,
        errors: [reason, firstFailure],
      });
      // A failed native join reports promptly even though preparation still holds input.
      await expect(pool.close()).rejects.toBe(retryFailure);
      preparation.resolve();
      await nextTurn();
      expect(observed).toEqual(["retained request"]);
      expect(captured).toEqual(["retained request"]);
      expect(consumed).not.toHaveBeenCalled();
      expect(contender).not.toHaveBeenCalled();
      expect(pool.getSnapshot().pendingTasks).toBe(1);
      expect(workers).toHaveLength(1);
      await pool.close();
      await expect(next).resolves.toBe("next pool");
      expect(worker.terminate).toHaveBeenCalledTimes(3);
      expect(consumed).toHaveBeenCalledOnce();
      expect(captured).toEqual([]);
      expect(pool.getSnapshot().pendingTasks).toBe(0);
      expect(worker.postMessage.mock.calls.map(([message]) => message.input)).toEqual(["warm"]);
      expect(await outcome).toBe(originalFailure);
    } finally {
      preparation.resolve();
      await Promise.allSettled([active, pool.close(), next]);
    }
  });

  it.each([
    { ending: "abort", failure: "input" },
    { ending: "close", failure: "input" },
    { ending: "abort", failure: "settlement" },
    { ending: "close", failure: "settlement" },
    { ending: "abort", failure: "both" },
    { ending: "close", failure: "both" },
  ])(
    "reports $failure cleanup failure through close after $ending rejects the result",
    async ({ ending, failure }) => {
      const pool = createPool({ maxPendingBytes: 8 });
      const preparation = createDeferredCore();
      const completed = createDeferredCore();
      const controller = new AbortController();
      const reason = new Error("original preparation cancellation");
      const cleanupError = new Error("input cleanup failed");
      const settlementError = new Error("execution receipt failed");
      const consumed = vi.fn(() => {
        completed.resolve();
        if (failure !== "settlement") {
          throw cleanupError;
        }
      });
      const executionSettled = vi.fn(() => {
        if (failure !== "input") {
          throw settlementError;
        }
      });
      const active = pool.run(
        async () => {
          await preparation.promise;
          return "must not post";
        },
        {
          signal: controller.signal,
          inputBytes: 8,
          onInputConsumed: consumed,
          onExecutionSettled: executionSettled,
        },
      );
      const rejected = expect(active).rejects.toBe(reason);
      const closing = ending === "close" ? pool.close(reason) : undefined;
      const closeOutcome = closing?.then(
        () => undefined,
        (error: unknown) => error,
      );
      if (ending === "abort") {
        controller.abort(reason);
      }
      try {
        await rejected;
        expect(executionSettled).toHaveBeenCalledExactlyOnceWith({ retired: true });
        expect(consumed).not.toHaveBeenCalled();
        preparation.resolve();
        await completed.promise;
        await nextTurn();
        let closeFailure: unknown;
        if (!closing) {
          expect(pool.getSnapshot().pendingTasks).toBe(1);
          await expect(pool.run("over capacity", { inputBytes: 1 })).rejects.toMatchObject({
            code: "overloaded",
          });
          closeFailure = await pool.close().catch((error: unknown) => error);
        } else {
          closeFailure = await closeOutcome;
        }
        if (failure === "both") {
          expect(closeFailure).toBeInstanceOf(AggregateError);
          expect(closeFailure).toMatchObject({
            errors: [settlementError, cleanupError],
            cause: settlementError,
          });
        } else {
          expect(closeFailure).toBe(failure === "input" ? cleanupError : settlementError);
        }
        await pool.close();
        expect(consumed).toHaveBeenCalledOnce();
        expect(executionSettled).toHaveBeenCalledOnce();
        expect(pool.getSnapshot().pendingTasks).toBe(0);
        expect(workers).toHaveLength(0);
        await expect(active).rejects.toBe(reason);
      } finally {
        preparation.resolve();
        await Promise.allSettled([active, closing, pool.close()]);
      }
    },
  );
});
