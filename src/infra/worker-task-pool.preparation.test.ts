import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as nativeSections from "../../packages/worker-runtime/src/worker-task-native-sections.js";
import { resolveSessionHistoryUnavailableMessage } from "../gateway/session-history-error.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "./diagnostic-events.js";
import type { WorkerPoolClass } from "./worker-pool-sizing.js";
import { createOwnedWorkerTaskPool, WorkerTaskError, WorkerTaskPool } from "./worker-task-pool.js";
import { expectCalls, holdExit, type MockWorker } from "./worker-task-pool.owned.test-support.js";
import type { WorkerTaskOptions, WorkerTaskPoolOptions } from "./worker-task-pool.types.js";

type PostedTask = {
  input: string;
  taskId: number;
  responseId?: number;
  nativeSections?: SharedArrayBuffer;
};
type FakeWorker = MockWorker<PostedTask>;
const workers = vi.hoisted(() => [] as FakeWorker[]);
const cpu = vi.hoisted(() => ({ count: 2 }));
const cleanup = vi.hoisted(() => vi.fn<() => Promise<void>>());
const taskPosted = vi.hoisted(() => vi.fn());
const replyAutomatically = vi.hoisted(() => ({ enabled: true }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => cpu.count,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { createMockWorkerClass } = await import("./worker-task-pool.owned.test-support.js");
  return {
    ...actual,
    Worker: createMockWorkerClass(workers, (worker, message) => {
      if (replyAutomatically.enabled) {
        queueMicrotask(() =>
          worker.emit("message", { status: "ok", taskId: message.taskId, value: message.input }),
        );
      } else {
        taskPosted();
      }
    }),
  };
});
vi.mock("./runtime-worker-url.js", () => ({ resolveRuntimeWorkerThreadExecArgv: () => [] }));
vi.mock("./temp-artifact-cleanup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./temp-artifact-cleanup.js")>()),
  removeTemporaryArtifacts: cleanup,
}));

const pools: WorkerTaskPool<string, string>[] = [];
const workerUrl = new URL("file:///fixture/preparation-worker.js");
function createPool(options: Partial<WorkerTaskPoolOptions<string>> = {}) {
  const pool = new WorkerTaskPool<string, string>({
    workerUrl,
    maxWorkers: 1,
    idleTimeoutMs: 0,
    ...options,
  });
  pools.push(pool);
  return pool;
}
beforeEach(() => {
  workers.splice(0);
  cleanup.mockReset().mockResolvedValue();
  taskPosted.mockReset();
  replyAutomatically.enabled = true;
});
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  cpu.count = 2;
});

class Preparation {
  preparation = createDeferredCore();
  captured = ["retained request"];
  observed?: string[];
  controller = new AbortController();
  consumed;
  active;
  constructor(
    pool: WorkerTaskPool<string, string>,
    options: { rejects?: boolean; onConsumed?: () => void; onExecutionSettled?: () => void } = {},
  ) {
    this.consumed = vi.fn(() => {
      options.onConsumed?.();
      this.captured.length = 0;
    });
    this.active = pool.run(
      async () => {
        await this.preparation.promise;
        this.observed = [...this.captured];
        if (options.rejects) {
          throw new Error("late preparation failure");
        }
        return this.captured.join(",");
      },
      {
        signal: this.controller.signal,
        inputBytes: 8,
        onInputConsumed: this.consumed,
        onExecutionSettled: options.onExecutionSettled,
      },
    );
  }
}

function contend() {
  const contender = vi.fn(() => "next pool");
  return { contender, next: createPool({ sharedCompute: true }).run(contender, {}) };
}

function expectRetained(
  fixture: Preparation,
  pool: WorkerTaskPool<string, string>,
  contender: ReturnType<typeof vi.fn>,
) {
  expect(fixture.captured).toEqual(["retained request"]);
  expectCalls(0, fixture.consumed, contender);
  expect(pool.getSnapshot().pendingTasks).toBe(1);
}

function expectReleased(fixture: Preparation, pool: WorkerTaskPool<string, string>) {
  expect(fixture.observed).toEqual(["retained request"]);
  expect(fixture.captured).toEqual([]);
  expect(fixture.consumed).toHaveBeenCalledOnce();
  expect(pool.getSnapshot().pendingTasks).toBe(0);
}

const postedInputs = (worker: FakeWorker) =>
  worker.posted.mock.calls.map(([message]) => message.input);

it.each<[number, WorkerPoolClass, number, boolean?, number?]>([
  [1, "reader", 1],
  [2, "reader", 1],
  [8, "reader", 2],
  [128, "file-reader", 2],
  [128, "compute", 4],
  [128, "writer", 1],
  [128, "singleton", 1],
  [128, "reader", 2, true],
  [128, "reader", 2, false, 1],
])(
  "bounds admission on %i CPUs (class=%s, admitted=%i, owned=%s)",
  async (cpus, workerClass, count, owned, maxWorkers) => {
    cpu.count = cpus;
    const options = { workerUrl, workerClass, maxWorkers };
    const pool = owned
      ? createOwnedWorkerTaskPool<string, string>(options)
      : new WorkerTaskPool<string, string>(options);
    const gate = createDeferredCore();
    const admitted: number[] = [];
    const inputs = Array.from({ length: 12 }, (_, index) => index);
    const results = inputs.map((index) =>
      pool.run(() => {
        admitted.push(index);
        return gate.promise.then(() => String(index));
      }, {}),
    );
    try {
      expect(admitted).toEqual(inputs.slice(0, count));
      expect(pool.getSnapshot().maxWorkers).toBe(count);
      gate.resolve();
      await expect(Promise.all(results)).resolves.toEqual(inputs.map(String));
      expect(admitted).toEqual(inputs);
      if (["reader", "file-reader", "compute"].includes(workerClass)) {
        expect(
          workers.map((worker) => worker.options?.resourceLimits?.maxOldGenerationSizeMb),
        ).toEqual(Array(count).fill(512));
      }
    } finally {
      gate.resolve();
      await Promise.all([Promise.allSettled(results), pool.close()]);
    }
  },
);

it.each([undefined, "reader"] as const)(
  "retains lazy inherited options (class=%s)",
  async (selectedClass) => {
    const releaseResources = vi.fn(async () => {});
    const readOptions = vi.fn();
    class Limits {
      get stackSizeMb() {
        return 8;
      }
    }
    class PoolOptions {
      #release = releaseResources;
      workerUrl = workerUrl;
      maxWorkers = 1;
      constructor(readonly workerClass: WorkerPoolClass | undefined) {}
      get workerOptions() {
        readOptions();
        return { resourceLimits: new Limits() };
      }
      prepareWorker() {
        return { options: {}, releaseResources: this.#release };
      }
    }
    const pool = new WorkerTaskPool<string, string>(new PoolOptions(selectedClass));
    pools.push(pool);
    expect(readOptions).not.toHaveBeenCalled();
    await expect(pool.run("prepared", {})).resolves.toBe("prepared");
    expect(readOptions).toHaveBeenCalledOnce();
    const limits = workers[0]?.options?.resourceLimits;
    expect([limits?.stackSizeMb, limits?.maxOldGenerationSizeMb]).toEqual([
      8,
      selectedClass ? 512 : undefined,
    ]);
    expect(releaseResources).not.toHaveBeenCalled();
    await pool.close();
    expect(releaseResources).toHaveBeenCalledOnce();
  },
);

it.each([true, false])("attributes private worker requests (owned=%s)", async (owned) => {
  const events: Extract<DiagnosticEventPayload, { type: "worker.request" }>[] = [];
  const unsubscribe = onTrustedInternalDiagnosticEvent(
    (event) => {
      if (event.type === "worker.request") {
        events.push(event);
      }
    },
    { include: ["worker.request"] },
  );
  const pool = owned
    ? createOwnedWorkerTaskPool<string, string>({
        workerUrl: new URL("file:///fixture/openclaw-state-read.worker.js"),
        maxWorkers: 1,
        idleTimeoutMs: 0,
      })
    : createPool({
        workerUrl: new URL("file:///synthetic-private-root/synthetic-private-worker.js"),
      });
  const gate = createDeferredCore<string>();
  try {
    const task =
      "runTask" in pool
        ? pool.runTask(() => gate.promise, {
            diagnosticOperation: "cron.synthetic-private-suffix",
          })
        : undefined;
    const result = task?.result ?? pool.run("synthetic-private-input", {});
    if (owned) {
      await waitForDiagnosticEventsDrained();
      expect(events[0]).toMatchObject({ phase: "queued", requestClass: "cron" });
    }
    gate.resolve("synthetic-private-input");
    await expect(result).resolves.toBe("synthetic-private-input");
    await task?.close();
    await waitForDiagnosticEventsDrained();
    expect(events.map((event) => (owned ? event.requestClass : event.kind))).toEqual(
      Array(3).fill(owned ? "cron" : "extension"),
    );
    expect(events.map((event) => event.phase)).toEqual(["queued", "started", "completed"]);
    expect(JSON.stringify(events)).not.toContain("synthetic-private");
  } finally {
    gate.resolve("cleanup");
    await pool.close();
    await waitForDiagnosticEventsDrained();
    unsubscribe();
  }
});

it("releases a rejected factory before its caller catches and immediately retries", async () => {
  const pool = createPool({ maxPendingTasks: 1 });
  await pool.run("warm", {});
  const worker = workers[0]!;
  const reason = new Error("factory rejected before dispatch");
  const consumed = vi.fn();
  const retried = pool
    .run(() => Promise.reject(reason), { onInputConsumed: consumed })
    .catch((error: unknown) => {
      expect(error).toBe(reason);
      expect(consumed).toHaveBeenCalledOnce();
      expect(pool.getSnapshot().pendingTasks).toBe(0);
      return pool.run("immediate retry", {});
    });
  await expect(retried).resolves.toBe("immediate retry");
  expect(workers).toHaveLength(1);
  expect(worker.terminate).not.toHaveBeenCalled();
  expect(postedInputs(worker)).toEqual(["warm", "immediate retry"]);
});

it.each(["preparation-first", "exit-first"] as const)(
  "retains preparation custody until native exit (%s)",
  async (order) => {
    const pool = createPool({ sharedCompute: true, maxPendingBytes: 8 });
    await expect(pool.run("warm", {})).resolves.toBe("warm");
    const worker = workers[0]!;
    const native = holdExit(worker);
    const context = new AsyncLocalStorage<string>();
    const assertContext = () => expect(context.getStore()).toBe("input owner");
    const executionSettled = vi.fn(assertContext);
    const reason = new Error("preparation canceled");
    const fixture = context.run(
      "input owner",
      () =>
        new Preparation(pool, {
          rejects: order === "exit-first",
          onConsumed: assertContext,
          onExecutionSettled: executionSettled,
        }),
    );
    const { preparation, captured, controller, active } = fixture;
    const rejected = expect(active).rejects.toBe(reason);
    const { contender, next } = contend();
    const rotation = pool.rotate();
    controller.abort(reason);
    try {
      await native.entered;
      expect(captured).toEqual(["retained request"]);
      expect(pool.getSnapshot().pendingTasks).toBe(1);
      await expect(pool.run("over capacity", { inputBytes: 1 })).rejects.toMatchObject({
        code: "overloaded",
      });
      if (order === "exit-first") {
        native.release();
        await rejected;
        expect(executionSettled).toHaveBeenCalledExactlyOnceWith({ retired: true });
        await rotation;
      } else {
        preparation.resolve();
        await nextTurn();
        expect(fixture.observed).toEqual(["retained request"]);
        expect(executionSettled).not.toHaveBeenCalled();
      }
      expectRetained(fixture, pool, contender);
      const closed = vi.fn();
      const closing = pool.close().then(closed);
      await nextTurn();
      expect(closed).not.toHaveBeenCalled();
      preparation.resolve();
      native.release();
      await Promise.all([closing, rotation, rejected]);
      await expect(next).resolves.toBe("next pool");
      expectReleased(fixture, pool);
      expect(executionSettled).toHaveBeenCalledExactlyOnceWith({ retired: true });
      expect(postedInputs(worker)).toEqual(["warm"]);
    } finally {
      preparation.resolve();
      native.release();
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
  const reason = new Error("canceled during preparation");
  const fixture = new Preparation(pool);
  const { preparation, controller, active } = fixture;
  const outcome = active.catch((error: unknown) => error);
  const { contender, next } = contend();
  controller.abort(reason);
  try {
    const originalFailure = await outcome;
    expect(originalFailure).toMatchObject({
      cause: firstFailure,
      errors: [reason, firstFailure],
    });
    await expect(pool.close()).rejects.toBe(retryFailure);
    preparation.resolve();
    await nextTurn();
    expect(fixture.observed).toEqual(["retained request"]);
    expectRetained(fixture, pool, contender);
    expect(workers).toHaveLength(1);
    await pool.close();
    await expect(next).resolves.toBe("next pool");
    expect(worker.terminate).toHaveBeenCalledTimes(3);
    expectReleased(fixture, pool);
    expect(postedInputs(worker)).toEqual(["warm"]);
  } finally {
    preparation.resolve();
    await Promise.allSettled([active, pool.close(), next]);
  }
});

it.each(["close", "abort"])(
  "reports cleanup failure through close after %s rejects the result",
  async (ending) => {
    const pool = createPool({ maxPendingBytes: 8 });
    const completed = createDeferredCore();
    const reason = new Error("original preparation cancellation");
    const cleanupError = new Error("input cleanup failed");
    const settlementError = new Error("execution receipt failed");
    const executionSettled = vi.fn(() => {
      throw settlementError;
    });
    const { preparation, controller, consumed, active } = new Preparation(pool, {
      onConsumed: () => {
        completed.resolve();
        if (ending === "abort") {
          throw cleanupError;
        }
      },
      onExecutionSettled: executionSettled,
    });
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
      if (!closing) {
        expect(pool.getSnapshot().pendingTasks).toBe(1);
        await expect(pool.run("over capacity", { inputBytes: 1 })).rejects.toMatchObject({
          code: "overloaded",
        });
      }
      const closeFailure = await (closeOutcome ?? pool.close().catch((error: unknown) => error));
      if (ending === "abort") {
        expect(closeFailure).toBeInstanceOf(AggregateError);
        expect(closeFailure).toMatchObject({
          errors: [settlementError, cleanupError],
          cause: settlementError,
        });
      } else {
        expect(closeFailure).toBe(settlementError);
      }
      await pool.close();
      expectCalls(1, consumed, executionSettled);
      expect(pool.getSnapshot().pendingTasks).toBe(0);
      expect(workers).toHaveLength(0);
    } finally {
      preparation.resolve();
      await Promise.allSettled([active, closing, pool.close()]);
    }
  },
);

const poolOptions = {
  workerUrl: new URL("data:text/javascript,"),
  maxWorkers: 1,
  idleTimeoutMs: 0,
};
function publicPool(options: Partial<WorkerTaskPoolOptions<string>> = {}) {
  replyAutomatically.enabled = false;
  return createPool({ ...poolOptions, ...options });
}
const createRetirementPool = (validateResult?: (value: string) => void) =>
  publicPool({ maxPendingBytes: 10, sharedCompute: true, validateResult });
function taskId(worker: FakeWorker) {
  return expectDefined(worker.posted.mock.calls[0]?.[0].taskId, "posted task");
}
const caught = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);
function send(worker: FakeWorker, message: { status: string; value?: string; id?: number }) {
  worker.emit("message", { taskId: taskId(worker), ...message });
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

it("settles cancellation when native work finishes before its settlement wait is registered", async () => {
  replyAutomatically.enabled = false;
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
    await nextTurn();
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
      await nextTurn();
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
        await nextTurn();
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
  const pool = createRetirementPool();
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
    const pool = createRetirementPool(() => {
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

    const waitingPool = createRetirementPool();
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
    const successor = expectDefined(workers[1], "waiting pool worker after exit");
    send(successor, { status: "ok", value: "completed" });
    expect(await waitingResult).toBe("completed");
    await pool[join]();
    expectCalls(1, inputReleased, responseReleased, executionSettled);
    expect(worker.terminate).toHaveBeenCalledTimes(2);
  },
);

it("settles a public failure before dispatching its queued successor", async () => {
  const pool = createRetirementPool();
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
  expect(order).toEqual(["settled:false", "successor"]);
  const message = await nextPosted.promise;
  worker.emit("message", { status: "ok", taskId: message.taskId, value: "next-completed" });
  expect(await queued).toBe("next-completed");
  expect(order).toEqual(["settled:false", "successor", "settled:false"]);
  expect(workers).toHaveLength(1);
  expect(worker.terminate).not.toHaveBeenCalled();
});
