import { AsyncLocalStorage } from "node:async_hooks";
import type { EventEmitter } from "node:events";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionHistoryUnavailableMessage } from "../gateway/session-history-error.js";
import { createDeferredCore } from "../shared/deferred.js";
import { WorkerTaskError, WorkerTaskPool } from "./worker-task-pool.js";

type FakeWorker = EventEmitter & {
  postMessage: ReturnType<typeof vi.fn<(message: { taskId: number; responseId?: number }) => void>>;
  terminate: ReturnType<typeof vi.fn<() => Promise<number>>>;
};
const workers = vi.hoisted(() => [] as FakeWorker[]);
const cleanup = vi.hoisted(() => vi.fn<() => Promise<void>>());

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    parentPort: null,
    Worker: class extends EventEmitter {
      constructor() {
        super();
        workers.push(this);
      }
      postMessage = vi.fn<(message: { taskId: number; responseId?: number }) => void>();
      ref() {}
      unref() {}
      terminate = vi.fn(async () => {
        this.emit("exit", 0);
        return 0;
      });
    },
  };
});
vi.mock("node:os", () => ({ availableParallelism: () => 2 }));
vi.mock("./runtime-worker-url.js", () => ({ resolveRuntimeWorkerThreadExecArgv: () => [] }));
vi.mock("./temp-artifact-cleanup.js", () => ({ removeTemporaryArtifacts: cleanup }));

const pools: WorkerTaskPool<string, string>[] = [];
function createPool(validateResult?: (value: string) => void) {
  const pool = new WorkerTaskPool<string, string>({
    workerUrl: new URL("data:text/javascript,"),
    maxWorkers: 1,
    maxPendingBytes: 10,
    sharedCompute: true,
    idleTimeoutMs: 0,
    validateResult,
  });
  pools.push(pool);
  return pool;
}
function taskId(worker: FakeWorker) {
  return expectDefined(worker.postMessage.mock.calls[0]?.[0].taskId, "posted task");
}

beforeEach(() => {
  workers.splice(0);
  cleanup.mockReset().mockResolvedValue();
});
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

describe("worker task retirement failures", () => {
  it.each([false, true])(
    "joins every retirement retry and its artifacts before rejecting (second retry fails: %s)",
    async (secondRetryFails) => {
      const pool = new WorkerTaskPool<string, string>({
        workerUrl: new URL("data:text/javascript,"),
        maxWorkers: 2,
        idleTimeoutMs: 0,
        prepareWorker: () => ({
          options: {},
          temporaryDirectory: `/fixture/worker-${workers.length}`,
        }),
      });
      pools.push(pool);
      const released = [vi.fn(), vi.fn()];
      const controllers = [new AbortController(), new AbortController()];
      const tasks = controllers.map((controller, index) =>
        pool
          .run(`input-${index}`, { signal: controller.signal, onInputConsumed: released[index] })
          .catch((error: unknown) => error),
      );
      for (const [index, worker] of workers.entries()) {
        worker.terminate.mockRejectedValueOnce(new Error("initial exit uncertain"));
        controllers[index]!.abort(new Error("task canceled"));
      }
      await Promise.all(tasks);
      const firstWorker = expectDefined(workers[0], "first failed worker");
      const secondWorker = expectDefined(workers[1], "second failed worker");
      const firstFailure = new Error("first retry failed");
      const secondFailure = new Error("second retry failed");
      firstWorker.terminate.mockRejectedValueOnce(firstFailure);
      const entered = createDeferredCore();
      const exit = createDeferredCore();
      const cleanupEntered = createDeferredCore();
      const cleanupReleased = createDeferredCore();
      secondWorker.terminate.mockImplementationOnce(async () => {
        entered.resolve();
        await exit.promise;
        if (secondRetryFails) {
          throw secondFailure;
        }
        secondWorker.emit("exit", 0);
        return 0;
      });
      cleanup.mockImplementationOnce(async () => {
        cleanupEntered.resolve();
        await cleanupReleased.promise;
      });
      let settled = false;
      const retry = pool
        .retryFailedRetirements()
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      try {
        await entered.promise;
        await yieldToEventLoop();
        expect(settled).toBe(false);
        expect(released.every((release) => release.mock.calls.length === 0)).toBe(true);
        expect(pool.getSnapshot().pendingTasks).toBe(2);
        exit.resolve();
        if (!secondRetryFails) {
          await cleanupEntered.promise;
          await yieldToEventLoop();
          expect(settled).toBe(false);
          expect(released[1]).toHaveBeenCalledOnce();
        }
        cleanupReleased.resolve();
        const failure = await retry;
        if (secondRetryFails) {
          expect(failure).toBeInstanceOf(AggregateError);
          expect(failure).toMatchObject({
            errors: [firstFailure, secondFailure],
            cause: firstFailure,
          });
        } else {
          expect(failure).toBe(firstFailure);
          expect(cleanup).toHaveBeenCalledExactlyOnceWith("/fixture/worker-1", "Worker task");
        }
        expect(released[0]).not.toHaveBeenCalled();
        expect(pool.getSnapshot().pendingTasks).toBe(secondRetryFails ? 2 : 1);
        await pool.retryFailedRetirements();
        expect(released.every((release) => release.mock.calls.length === 1)).toBe(true);
        expect(pool.getSnapshot().pendingTasks).toBe(0);
      } finally {
        exit.resolve();
        cleanupReleased.resolve();
        await retry;
      }
    },
  );

  it("retries failed retirement without terminating or waiting for a healthy sibling", async () => {
    const pool = new WorkerTaskPool<string, string>({
      workerUrl: new URL("data:text/javascript,"),
      maxWorkers: 2,
      idleTimeoutMs: 0,
    });
    pools.push(pool);
    const controller = new AbortController();
    const released = vi.fn();
    const failed = pool.run("failed", {
      signal: controller.signal,
      onInputConsumed: released,
    });
    const rejected = expect(failed).rejects.toThrow("exit uncertain");
    let healthySettled = false;
    const healthy = pool
      .run("healthy", {})
      .catch((error: unknown) => error)
      .finally(() => {
        healthySettled = true;
      });
    const failedWorker = expectDefined(workers[0], "failed worker");
    const healthyWorker = expectDefined(workers[1], "healthy sibling worker");
    failedWorker.terminate.mockRejectedValueOnce(new Error("exit uncertain"));
    controller.abort(new Error("failed task"));
    await rejected;
    const entered = createDeferredCore();
    const exit = createDeferredCore();
    failedWorker.terminate.mockImplementationOnce(async () => {
      entered.resolve();
      await exit.promise;
      failedWorker.emit("exit", 0);
      return 0;
    });
    const retirement = pool.retryFailedRetirements();
    try {
      await entered.promise;
      expect(released).not.toHaveBeenCalled();
      expect(healthyWorker.terminate).not.toHaveBeenCalled();
      expect(pool.getSnapshot().pendingTasks).toBe(2);
    } finally {
      exit.resolve();
      await retirement;
    }
    expect(released).toHaveBeenCalledOnce();
    expect(pool.getSnapshot().pendingTasks).toBe(1);
    expect(healthySettled).toBe(false);
    expect(healthyWorker.terminate).not.toHaveBeenCalled();
    healthyWorker.emit("message", {
      status: "ok",
      taskId: taskId(healthyWorker),
      value: "healthy result",
    });
    expect(await healthy).toBe("healthy result");
    expect(pool.getSnapshot().pendingTasks).toBe(0);
  });

  it("does not turn a consumption receipt into native exit when later cancellation cannot retire", async () => {
    const pool = createPool();
    const released = vi.fn();
    const controller = new AbortController();
    const result = pool.run("input", {
      onInputConsumed: released,
      onRequest: async () => {
        throw new Error("Consumption-only task must not request host work");
      },
      signal: controller.signal,
    });
    const rejected = expect(result).rejects.toThrow("exit uncertain");
    const worker = expectDefined(workers[0], "task worker");
    const exited = vi.fn();
    worker.on("exit", exited);
    worker.emit("message", { status: "consumed", taskId: taskId(worker), id: 0 });
    worker.terminate.mockRejectedValueOnce(new Error("exit uncertain"));
    controller.abort(new Error("canceled after consumption"));
    await rejected;
    expect(released).toHaveBeenCalledOnce();
    expect(exited).not.toHaveBeenCalled();
    expect(pool.getSnapshot().pendingTasks).toBe(1);
    await pool.close();
    expect(exited).toHaveBeenCalledOnce();
    expect(released).toHaveBeenCalledOnce();
  });

  it.each(["close", "rotate"] as const)(
    "retains both failures and input custody until a later %s joins exit",
    async (join) => {
      const taskFailure = new WorkerTaskError("original task failure", "unavailable");
      const retirementFailure = new Error("exit uncertain");
      const pool = createPool(() => {
        throw taskFailure;
      });
      const inputReleased = vi.fn();
      const responseReleased = vi.fn();
      const context = new AsyncLocalStorage<string>();
      const executionSettled = vi.fn(() => context.getStore());
      const responsePosted = createDeferredCore();
      const result = context
        .run("admitted", () =>
          pool.run("input", {
            inputBytes: 8,
            onInputConsumed: inputReleased,
            onExecutionSettled: executionSettled,
            onRequest: async () => ({
              input: "host reply",
              timeoutMs: 60_000,
              onConsumed: responseReleased,
            }),
          }),
        )
        .catch((error: unknown) => error);
      const worker = expectDefined(workers[0], "task worker");
      worker.postMessage.mockImplementation((message) => {
        if (message.responseId !== undefined) {
          responsePosted.resolve();
        }
      });
      worker.emit("message", {
        status: "request",
        taskId: taskId(worker),
        id: 1,
        value: "request",
      });
      await responsePosted.promise;
      worker.terminate.mockRejectedValueOnce(retirementFailure);
      worker.emit("message", { status: "ok", taskId: taskId(worker), value: "result" });
      const failure = await result;
      expect(failure).toBeInstanceOf(AggregateError);
      const aggregate = expectDefined(
        failure instanceof AggregateError ? failure : undefined,
        "both task and retirement failures",
      );
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBe(taskFailure);
      expect(aggregate.errors[1]).toBe(retirementFailure);
      expect(aggregate.cause).toBe(retirementFailure);
      expect(aggregate.message).toMatch(/exit uncertain.*original task failure/);
      expect(failure).not.toBeInstanceOf(WorkerTaskError);
      expect(resolveSessionHistoryUnavailableMessage(taskFailure)).toBeDefined();
      expect(resolveSessionHistoryUnavailableMessage(failure)).toBeUndefined();
      expect(inputReleased).not.toHaveBeenCalled();
      expect(responseReleased).not.toHaveBeenCalled();
      expect(executionSettled).not.toHaveBeenCalled();
      expect(pool.getSnapshot().pendingTasks).toBe(1);
      await expect(pool.run("too large", { inputBytes: 3 })).rejects.toMatchObject({
        code: "overloaded",
      });

      const waitingPool = createPool();
      const waitingResult = waitingPool.run("waiting", {}).catch((error: unknown) => error);
      expect(workers).toHaveLength(1);
      const exit = createDeferredCore();
      const terminating = createDeferredCore();
      worker.terminate.mockImplementationOnce(async () => {
        terminating.resolve();
        await exit.promise;
        worker.emit("exit", 0);
        return 0;
      });
      const joined = pool[join]();
      try {
        await terminating.promise;
        expect(inputReleased).not.toHaveBeenCalled();
        expect(responseReleased).not.toHaveBeenCalled();
        expect(executionSettled).not.toHaveBeenCalled();
        expect(pool.getSnapshot().pendingTasks).toBe(1);
        expect(workers).toHaveLength(1);
      } finally {
        exit.resolve();
        await joined;
      }
      expect(inputReleased).toHaveBeenCalledOnce();
      expect(responseReleased).toHaveBeenCalledOnce();
      expect(executionSettled).toHaveBeenCalledExactlyOnceWith({ retired: true });
      expect(executionSettled.mock.results[0]?.value).toBe("admitted");
      expect(pool.getSnapshot().pendingTasks).toBe(0);
      expect(await result).toBe(failure);
      const successor = expectDefined(workers[1], "waiting pool worker after exit");
      successor.emit("message", { status: "ok", taskId: taskId(successor), value: "completed" });
      expect(await waitingResult).toBe("completed");
      await pool[join]();
      expect(inputReleased).toHaveBeenCalledOnce();
      expect(responseReleased).toHaveBeenCalledOnce();
      expect(executionSettled).toHaveBeenCalledOnce();
      expect(worker.terminate).toHaveBeenCalledTimes(2);
    },
  );

  it("preserves the retirement failure alone when the task succeeded", async () => {
    const pool = createPool();
    const released = vi.fn();
    const result = pool.run("input", { onInputConsumed: released });
    const retirementFailure = new Error("exit uncertain");
    const worker = expectDefined(workers[0], "task worker");
    worker.terminate.mockRejectedValueOnce(retirementFailure);
    const rejected = expect(result).rejects.toBe(retirementFailure);
    worker.emit("message", { status: "ok", taskId: taskId(worker), value: "result" });
    await rejected;
    expect(released).not.toHaveBeenCalled();
    await pool.close();
    expect(released).toHaveBeenCalledOnce();
  });

  it("preserves the original task error when retirement succeeds", async () => {
    const taskFailure = new WorkerTaskError("original task failure", "unavailable");
    const pool = createPool(() => {
      throw taskFailure;
    });
    const released = vi.fn();
    const result = pool.run("input", { onInputConsumed: released });
    const rejected = expect(result).rejects.toBe(taskFailure);
    const worker = expectDefined(workers[0], "task worker");
    worker.emit("message", { status: "ok", taskId: taskId(worker), value: "result" });
    await rejected;
    expect(released).toHaveBeenCalledOnce();
  });

  it.each(["ok", "failed"] as const)(
    "reports each native settlement when reusing frozen options after a %s reply",
    async (outcome) => {
      const pool = createPool();
      const order: string[] = [];
      const executionSettled = vi.fn(({ retired }: { retired: boolean }) => {
        order.push(`settled:${retired}`);
      });
      const options = Object.freeze({ onExecutionSettled: executionSettled });
      const first = pool.run("first", options).catch((error: unknown) => error);
      const worker = expectDefined(workers[0], "task worker");
      const nextPosted = createDeferredCore<{ taskId: number }>();
      worker.postMessage.mockImplementation((message) => nextPosted.resolve(message));
      const next = pool
        .run(() => {
          order.push("successor");
          return "next";
        }, options)
        .catch((error: unknown) => error);
      worker.emit(
        "message",
        outcome === "ok"
          ? { status: "ok", taskId: taskId(worker), value: "completed" }
          : { status: "failed", taskId: taskId(worker), error: "handler failure" },
      );
      const result = await first;
      if (outcome === "ok") {
        expect(result).toBe("completed");
      } else {
        expect(result).toMatchObject({ message: "handler failure", code: "failed" });
      }
      expect(executionSettled).toHaveBeenCalledExactlyOnceWith({ retired: false });
      expect(order).toEqual(["settled:false", "successor"]);
      expect(workers).toHaveLength(1);
      expect(worker.terminate).not.toHaveBeenCalled();
      const message = await nextPosted.promise;
      worker.emit("message", { status: "ok", taskId: message.taskId, value: "next-completed" });
      expect(await next).toBe("next-completed");
      expect(executionSettled).toHaveBeenCalledTimes(2);
      expect(order).toEqual(["settled:false", "successor", "settled:false"]);
      expect(options.onExecutionSettled).toBe(executionSettled);
    },
  );
  it.each(["ok", "failed"] as const)(
    "preserves public result error precedence when settlement callback throws after %s",
    async (outcome) => {
      const pool = createPool();
      const callbackFailure = new Error("settlement callback failed");
      const executionSettled = vi.fn(() => {
        throw callbackFailure;
      });
      const first = pool
        .run("first", { onExecutionSettled: executionSettled })
        .catch((error: unknown) => error);
      const worker = expectDefined(workers[0], "task worker");
      worker.emit(
        "message",
        outcome === "ok"
          ? { status: "ok", taskId: taskId(worker), value: "first" }
          : { status: "failed", taskId: taskId(worker), error: "original worker failure" },
      );
      const result = await first;
      if (outcome === "ok") {
        expect(result).toBe(callbackFailure);
      } else {
        expect(result).toMatchObject({ message: "original worker failure", code: "failed" });
        expect(result).not.toBe(callbackFailure);
      }
      expect(executionSettled).toHaveBeenCalledExactlyOnceWith({ retired: false });
      expect(pool.getSnapshot().pendingTasks).toBe(0);
      const next = pool.run("next", {});
      const posted = expectDefined(worker.postMessage.mock.calls.at(-1)?.[0], "successor request");
      worker.emit("message", { status: "ok", taskId: posted.taskId, value: "next" });
      expect(await next).toBe("next");
      expect(workers).toHaveLength(1);
      expect(worker.terminate).not.toHaveBeenCalled();
    },
  );
});
