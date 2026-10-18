import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as nativeSections from "../../packages/worker-runtime/src/worker-task-native-sections.js";
import { resolveSessionHistoryUnavailableMessage } from "../gateway/session-history-error.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOwnedWorkerTaskPool, WorkerTaskError, WorkerTaskPool } from "./worker-task-pool.js";
import { holdExit, type MockWorker } from "./worker-task-pool.owned.test-support.js";
import type { WorkerTaskOptions, WorkerTaskPoolOptions } from "./worker-task-pool.types.js";

type PostedTask = { taskId: number; responseId?: number; nativeSections?: SharedArrayBuffer };

type FakeWorker = MockWorker<PostedTask>;
const workers = vi.hoisted(() => [] as FakeWorker[]);
const cleanup = vi.hoisted(() => vi.fn<() => Promise<void>>());
const taskPosted = vi.hoisted(() => vi.fn());

vi.mock("node:worker_threads", async (importOriginal) => {
  const { createMockWorkerClass } = await import("./worker-task-pool.owned.test-support.js");
  return {
    ...(await importOriginal<typeof import("node:worker_threads")>()),
    parentPort: null,
    Worker: createMockWorkerClass(workers, () => taskPosted()),
  };
});
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 2,
}));
vi.mock("./runtime-worker-url.js", () => ({ resolveRuntimeWorkerThreadExecArgv: () => [] }));
vi.mock("./temp-artifact-cleanup.js", () => ({ removeTemporaryArtifacts: cleanup }));

const pools: WorkerTaskPool<string, string>[] = [];
const poolOptions = {
  workerUrl: new URL("data:text/javascript,"),
  maxWorkers: 1,
  idleTimeoutMs: 0,
};
function publicPool(options: Partial<WorkerTaskPoolOptions<string>> = {}) {
  const pool = new WorkerTaskPool<string, string>({ ...poolOptions, ...options });
  pools.push(pool);
  return pool;
}
const createPool = (validateResult?: (value: string) => void) =>
  publicPool({ maxPendingBytes: 10, sharedCompute: true, validateResult });
function taskId(worker: FakeWorker) {
  return expectDefined(worker.posted.mock.calls[0]?.[0].taskId, "posted task");
}
const caught = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);
function send(worker: FakeWorker, message: { status: string; value?: string; id?: number }) {
  worker.emit("message", { taskId: taskId(worker), ...message });
}
function expectCalls(count: number, ...callbacks: ReturnType<typeof vi.fn>[]) {
  for (const callback of callbacks) {
    expect(callback).toHaveBeenCalledTimes(count);
  }
}
function expectAggregate(failure: unknown, errors: Error[], cause: Error) {
  assert.ok(failure instanceof AggregateError, "aggregate failure");
  expect(failure.errors).toHaveLength(errors.length);
  errors.forEach((error, index) => expect(failure.errors[index]).toBe(error));
  expect(failure.cause).toBe(cause);
  return failure;
}
function cancelable(pool: WorkerTaskPool<string, string>, options: WorkerTaskOptions<string> = {}) {
  const controller = new AbortController();
  const released = vi.fn();
  const result = pool.run("input", {
    signal: controller.signal,
    onInputConsumed: released,
    ...options,
  });
  return { controller, released, result };
}

beforeEach(() => {
  workers.splice(0);
  cleanup.mockReset().mockResolvedValue();
  taskPosted.mockReset();
});
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

it("settles cancellation when native work finishes before its settlement wait is registered", async () => {
  const pool = createOwnedWorkerTaskPool<string, string>(poolOptions);
  const controller = new AbortController();
  const reason = new Error("cancel native work");
  const executionSettled = vi.fn();
  const result = caught(
    pool.run("input", { signal: controller.signal, onExecutionSettled: executionSettled }),
  );
  const worker = expectDefined(workers[0], "task worker");
  const state = new Int32Array(
    expectDefined(worker.posted.mock.calls[0]?.[0].nativeSections, "native section state"),
  );
  const release = nativeSections.withWorkerTaskNativeSectionScope(
    state,
    () => true,
    nativeSections.retainCurrentWorkerNativeSection,
  );
  const isSettled = nativeSections.areWorkerNativeSectionsSettled;
  const observed = vi
    .spyOn(nativeSections, "areWorkerNativeSectionsSettled")
    .mockImplementationOnce((sections) => {
      const settled = isSettled(sections);
      // The worker can release its last section after the parent's atomic read.
      release();
      return settled;
    });
  try {
    controller.abort(reason);
    await yieldToEventLoop();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(await result).toBe(reason);
    expect(executionSettled).toHaveBeenCalledExactlyOnceWith({ retired: true });
    expect(pool.getSnapshot().pendingTasks).toBe(0);
  } finally {
    observed.mockRestore();
    release();
    // Explicit servicing also cleans up the deliberately stalled pre-fix owner.
    const rotation = pool.startRotate();
    rotation.service();
    await rotation.result;
    await pool.close();
    await result;
  }
});

it.each([false, true])(
  "joins every retirement retry and its artifacts before rejecting (second retry fails: %s)",
  async (secondRetryFails) => {
    const admitted = createDeferredCore();
    taskPosted.mockImplementationOnce(() => {}).mockImplementationOnce(() => admitted.resolve());
    const pool = publicPool({
      maxWorkers: 2,
      prepareWorker: () => ({
        options: {},
        temporaryDirectory: `/fixture/worker-${workers.length}`,
      }),
    });
    const tasks = [cancelable(pool), cancelable(pool)];
    const results = tasks.map(({ result }) => caught(result));
    const released = tasks.map((task) => task.released);
    await admitted.promise;
    expect(workers).toHaveLength(2);
    for (const [index, worker] of workers.entries()) {
      worker.terminate.mockRejectedValueOnce(new Error("initial exit uncertain"));
      tasks[index]!.controller.abort(new Error("task canceled"));
    }
    await Promise.all(results);
    const firstWorker = expectDefined(workers[0], "first failed worker");
    const secondWorker = expectDefined(workers[1], "second failed worker");
    const firstFailure = new Error("first retry failed");
    const secondFailure = new Error("second retry failed");
    firstWorker.terminate.mockRejectedValueOnce(firstFailure);
    const native = holdExit(secondWorker);
    const cleanupEntered = createDeferredCore();
    const cleanupReleased = createDeferredCore();
    cleanup.mockImplementationOnce(async () => {
      cleanupEntered.resolve();
      await cleanupReleased.promise;
    });
    const settled = vi.fn();
    const retry = caught(pool.retryFailedRetirements()).finally(settled);
    try {
      await native.entered;
      await yieldToEventLoop();
      expect(settled).not.toHaveBeenCalled();
      expectCalls(0, ...released);
      expect(pool.getSnapshot().pendingTasks).toBe(2);
      if (secondRetryFails) {
        native.reject(secondFailure);
      } else {
        native.release();
      }
      if (!secondRetryFails) {
        await cleanupEntered.promise;
        await yieldToEventLoop();
        expect(settled).not.toHaveBeenCalled();
        expect(released[1]).toHaveBeenCalledOnce();
      }
      cleanupReleased.resolve();
      const failure = await retry;
      if (secondRetryFails) {
        expectAggregate(failure, [firstFailure, secondFailure], firstFailure);
      } else {
        expect(failure).toBe(firstFailure);
        expect(cleanup).toHaveBeenCalledExactlyOnceWith("/fixture/worker-1", "Worker task");
      }
      expect(released[0]).not.toHaveBeenCalled();
      expect(pool.getSnapshot().pendingTasks).toBe(secondRetryFails ? 2 : 1);
      await pool.retryFailedRetirements();
      expectCalls(1, ...released);
      expect(pool.getSnapshot().pendingTasks).toBe(0);
    } finally {
      native.release();
      cleanupReleased.resolve();
      await retry;
    }
  },
);

it("retries failed retirement without terminating or waiting for a healthy sibling", async () => {
  const pool = publicPool({ maxWorkers: 2 });
  const { controller, released, result } = cancelable(pool);
  const rejected = expect(result).rejects.toThrow("exit uncertain");
  const healthySettled = vi.fn();
  const healthy = caught(pool.run("healthy", {})).finally(healthySettled);
  const failedWorker = expectDefined(workers[0], "failed worker");
  const healthyWorker = expectDefined(workers[1], "healthy sibling worker");
  failedWorker.terminate.mockRejectedValueOnce(new Error("exit uncertain"));
  controller.abort(new Error("failed task"));
  await rejected;
  const native = holdExit(failedWorker);
  const retirement = pool.retryFailedRetirements();
  try {
    await native.entered;
    expect(released).not.toHaveBeenCalled();
    expect(healthyWorker.terminate).not.toHaveBeenCalled();
    expect(pool.getSnapshot().pendingTasks).toBe(2);
  } finally {
    native.release();
    await retirement;
  }
  expect(released).toHaveBeenCalledOnce();
  expect(pool.getSnapshot().pendingTasks).toBe(1);
  expect(healthySettled).not.toHaveBeenCalled();
  expect(healthyWorker.terminate).not.toHaveBeenCalled();
  send(healthyWorker, { status: "ok", value: "healthy result" });
  expect(await healthy).toBe("healthy result");
  expect(pool.getSnapshot().pendingTasks).toBe(0);
});

it("does not turn a consumption receipt into native exit when later cancellation cannot retire", async () => {
  const pool = createPool();
  const { controller, released, result } = cancelable(pool, {
    onRequest: async () => {
      throw new Error("Consumption-only task must not request host work");
    },
  });
  const rejected = expect(result).rejects.toThrow("exit uncertain");
  const worker = expectDefined(workers[0], "task worker");
  const exited = vi.fn();
  worker.on("exit", exited);
  send(worker, { status: "consumed", id: 0 });
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
    const result = caught(
      context.run("admitted", () =>
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
      ),
    );
    const worker = expectDefined(workers[0], "task worker");
    worker.posted.mockImplementation((message) => {
      if (message.responseId !== undefined) {
        responsePosted.resolve();
      }
    });
    send(worker, { status: "request", id: 1, value: "request" });
    await responsePosted.promise;
    worker.terminate.mockRejectedValueOnce(retirementFailure);
    send(worker, { status: "ok", value: "result" });
    const failure = await result;
    const aggregate = expectAggregate(failure, [taskFailure, retirementFailure], retirementFailure);
    expect(aggregate.message).toMatch(/exit uncertain.*original task failure/);
    expect(failure).not.toBeInstanceOf(WorkerTaskError);
    expect(resolveSessionHistoryUnavailableMessage(taskFailure)).toBeDefined();
    expect(resolveSessionHistoryUnavailableMessage(failure)).toBeUndefined();
    expectCalls(0, inputReleased, responseReleased, executionSettled);
    expect(pool.getSnapshot().pendingTasks).toBe(1);
    await expect(pool.run("too large", { inputBytes: 3 })).rejects.toMatchObject({
      code: "overloaded",
    });

    const waitingPool = createPool();
    const waitingResult = caught(waitingPool.run("waiting", {}));
    expect(workers).toHaveLength(1);
    const native = holdExit(worker);
    const joined = pool[join]();
    try {
      await native.entered;
      expectCalls(0, inputReleased, responseReleased, executionSettled);
      expect(pool.getSnapshot().pendingTasks).toBe(1);
      expect(workers).toHaveLength(1);
    } finally {
      native.release();
      await joined;
    }
    expectCalls(1, inputReleased, responseReleased);
    expect(executionSettled).toHaveBeenCalledExactlyOnceWith({ retired: true });
    expect(executionSettled.mock.results[0]?.value).toBe("admitted");
    expect(pool.getSnapshot().pendingTasks).toBe(0);
    expect(await result).toBe(failure);
    const successor = expectDefined(workers[1], "waiting pool worker after exit");
    send(successor, { status: "ok", value: "completed" });
    expect(await waitingResult).toBe("completed");
    await pool[join]();
    expectCalls(1, inputReleased, responseReleased, executionSettled);
    expect(worker.terminate).toHaveBeenCalledTimes(2);
  },
);

it("settles a public failure before dispatching its queued successor", async () => {
  const pool = createPool();
  const order: string[] = [];
  const executionSettled = vi.fn(({ retired }: { retired: boolean }) => {
    order.push(`settled:${retired}`);
  });
  const options = Object.freeze({ onExecutionSettled: executionSettled });
  const first = caught(pool.run("first", options));
  const worker = expectDefined(workers[0], "task worker");
  const nextPosted = createDeferredCore<{ taskId: number }>();
  worker.posted.mockImplementation((message) => nextPosted.resolve(message));
  const queued = caught(
    pool.run(() => {
      order.push("successor");
      return "next";
    }, options),
  );
  worker.emit("message", { status: "failed", taskId: taskId(worker), error: "handler failure" });
  expect(await first).toMatchObject({ message: "handler failure", code: "failed" });
  expect(executionSettled).toHaveBeenCalledExactlyOnceWith({ retired: false });
  expect(order).toEqual(["settled:false", "successor"]);
  const message = await nextPosted.promise;
  worker.emit("message", { status: "ok", taskId: message.taskId, value: "next-completed" });
  expect(await queued).toBe("next-completed");
  expect(order).toEqual(["settled:false", "successor", "settled:false"]);
  expect(workers).toHaveLength(1);
  expect(worker.terminate).not.toHaveBeenCalled();
});
