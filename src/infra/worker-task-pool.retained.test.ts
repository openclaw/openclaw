import { AsyncLocalStorage } from "node:async_hooks";
import { mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import type { RetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { afterEach, expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  captureRuntimeWorkerSource,
  withRuntimeWorkerGeneration,
} from "./runtime-worker-generation.js";
import { captureRetainedNativeWorkerSource } from "./worker-native-lifecycle.js";
import { createOwnedWorkerTaskPool } from "./worker-task-pool.js";
import type {
  ResourceFixtureInput,
  ResourceFixtureReply,
} from "./worker-task-pool.resources.test-support.js";
import type { PoolFixtureInput, PoolFixtureResult } from "./worker-task-pool.test-support.js";
import type { RetainedWorkerTask, WorkerTaskResponse } from "./worker-task-pool.types.js";

const pools: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

it("retains an admitted task when abort reentry targets another worker of a failed source", async () => {
  await withRuntimeWorkerGeneration(
    async (bind) => {
      const marker = new URL("./retained-ref-marker", import.meta.url);
      const retainedMarker = new URL("?retained", marker);
      bind((url) => (url.href === marker.href ? retainedMarker : url));
      const generation = captureRuntimeWorkerSource(marker).runtimeGeneration;
      if (!generation) {
        throw new Error("Expected an isolated native source generation");
      }
      const source = captureRetainedNativeWorkerSource({ runtimeGeneration: generation });
      const createPool = () => {
        const pool = createOwnedWorkerTaskPool<PoolFixtureInput, PoolFixtureResult>(
          {
            workerUrl: new URL("./worker-task-pool.test-support.ts", import.meta.url),
            maxWorkers: 1,
            idleTimeoutMs: 0,
          },
          { retainedTransport: true, nativeSource: source },
        );
        source.retain(pool, async () => {
          try {
            await pool.close();
          } catch {
            // Observe the first stop failure before retrying after the actual supervisor join.
            await pool.close();
          }
        });
        return pool;
      };
      const firstPool = createPool();
      const secondPool = createPool();
      const entered = createDeferredCore();
      const response = createDeferredCore<WorkerTaskResponse>();
      let reentered: RetainedWorkerTask<PoolFixtureResult> | undefined;
      let submissionError: unknown;
      let factoryCalled = false;
      const registrations = mock.method(Worker.prototype, "on");
      const first = firstPool.startTask(
        { label: "first", exchanges: 1 },
        {
          onRequest(_value, { signal }) {
            signal.addEventListener(
              "abort",
              () => {
                try {
                  reentered = secondPool.startTask(() => {
                    factoryCalled = true;
                    return { label: "reentered" };
                  }, {});
                } catch (error) {
                  submissionError = error;
                }
              },
              { once: true },
            );
            entered.resolve();
            return response.promise;
          },
        },
      );
      const supervisor = registrations.mock.calls
        .map((call) => call.this)
        .find((value) => value instanceof Worker);
      registrations.mock.restore();
      if (!(supervisor instanceof Worker)) {
        throw new Error("Expected the actual supervising Worker");
      }
      let termination: Promise<number> | undefined;
      try {
        await entered.promise;
        const warm = secondPool.startTask({ label: "warm" }, {});
        await warm.result;
        await warm.release().result;
        expect(secondPool.getSnapshot().pendingTasks).toBe(0);
        termination = supervisor.terminate();
        serviceUntil(
          () => first.service(),
          () => first.read().status !== "pending",
        );
        expect(secondPool.getSnapshot().pendingTasks).toBe(1);
        expect(factoryCalled).toBe(false);
        expect(submissionError).toBeUndefined();
        expect(reentered).toBeDefined();
        if (!reentered) {
          throw new Error("Admission lost its retained task handle");
        }
        expect(reentered.read().status).toBe("rejected");
        await termination;
        await nextTurn();
        await reentered.release().result.catch(() => undefined);
        await reentered.release().result;
        expect(secondPool.getSnapshot().pendingTasks).toBe(0);
      } finally {
        response.resolve({ input: null, timeoutMs: 1000 });
        await (termination ?? supervisor.terminate());
        await nextTurn();
      }
    },
    async () => {},
  );
}, 20_000);

function fixture() {
  const pool = createOwnedWorkerTaskPool<ResourceFixtureInput, ResourceFixtureReply>(
    {
      workerUrl: new URL("./worker-task-pool.resources.test-support.ts", import.meta.url),
      maxWorkers: 1,
      idleTimeoutMs: 0,
    },
    { retainedTransport: true },
  );
  pools.push(pool);
  return pool;
}

const pause = new Int32Array(new SharedArrayBuffer(4));
function serviceUntil(service: () => void, ready: () => boolean): void {
  const deadline = performance.now() + 10_000;
  while (!ready()) {
    if (performance.now() >= deadline) {
      throw new Error("Retained worker operation did not settle");
    }
    service();
    Atomics.wait(pause, 0, 0, 1);
  }
}

function read<T>(operation: RetainedOperation<T>): T {
  serviceUntil(
    () => operation.service(),
    () => operation.read().status !== "pending",
  );
  const outcome = operation.read();
  if (outcome.status === "rejected") {
    throw outcome.error;
  }
  if (outcome.status === "pending") {
    throw new Error("Retained worker outcome was lost");
  }
  return outcome.value;
}

it("services an earlier task before a queued read and preserves settlement context through native retirement", () => {
  const pool = fixture();
  const context = new AsyncLocalStorage<string>();
  const settlements: Array<string | undefined> = [];
  const barrier = new Int32Array(new SharedArrayBuffer(8));
  let promiseReaction = false;
  const first = context.run("first", () =>
    pool.startTask(
      { retain: "first", wait: barrier.buffer },
      { onExecutionSettled: () => settlements.push(context.getStore()) },
    ),
  );
  const second = context.run("second", () =>
    pool.startTask(
      { retain: "second" },
      { onExecutionSettled: () => settlements.push(context.getStore()) },
    ),
  );
  void first.result.then(() => {
    promiseReaction = true;
  });
  try {
    serviceUntil(
      () => second.service(),
      () => Atomics.load(barrier, 0) === 1,
    );
    expect(second.read().status).toBe("pending");
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1);
    const firstReply = read(first);
    expect(firstReply.keys).toEqual(["first"]);
    expect(second.read().status).toBe("pending");
    read(first.release());
    const secondReply = read(second);
    expect(secondReply).toEqual({
      keys: ["first", "second"],
      threadId: firstReply.threadId,
    });
    read(second.release({ retire: true }));
    expect(settlements).toEqual(["first", "second"]);
    expect(pool.getSnapshot().workers).toBe(0);
    expect(promiseReaction).toBe(false);
  } finally {
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1);
  }
});

it("services resource cleanup and its error without discarding sibling resources", () => {
  const pool = fixture();
  const run = (input: ResourceFixtureInput) => {
    const task = pool.startTask(input, {});
    const value = read(task);
    read(task.release());
    return value;
  };
  const first = run({ retain: "first" });
  run({ retain: "second" });
  run({ retain: "fail-once" });
  expect(() => read(pool.startCloseResources("fail-once"))).toThrow(
    "Worker resource cleanup failed",
  );
  read(pool.startCloseResources("fail-once"));
  read(pool.startCloseResources("first"));
  expect(run({})).toEqual({ keys: ["second"], threadId: first.threadId });
  read(pool.startCloseResources());
  expect(run({})).toEqual({ keys: [], threadId: first.threadId });
  read(pool.startRotate());
  expect(pool.getSnapshot().workers).toBe(0);
});

it("enforces the existing task deadline while the caller cannot run timers and joins retirement before reuse", () => {
  const pool = fixture();
  const warm = pool.startTask({}, {});
  const oldThread = read(warm).threadId;
  read(warm.release());
  const barrier = new Int32Array(new SharedArrayBuffer(8));
  const blocked = pool.startTask({ wait: barrier.buffer }, { timeoutMs: 500 });
  const successor = pool.startTask({ retain: "successor" }, {});
  try {
    serviceUntil(
      () => blocked.service(),
      () => Atomics.load(barrier, 0) === 1,
    );
    expect(() => read(blocked)).toThrow("worker task timed out");
    read(blocked.release());
    const reply = read(successor);
    expect(reply.keys).toEqual(["successor"]);
    expect(reply.threadId).not.toBe(oldThread);
    read(successor.release({ retire: true }));
    expect(pool.getSnapshot().workers).toBe(0);
  } finally {
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1);
  }
});

it("answers an earlier task's synchronous host exchange while servicing a queued task", () => {
  const pool = createOwnedWorkerTaskPool<PoolFixtureInput, PoolFixtureResult>(
    {
      workerUrl: new URL("./worker-task-pool.test-support.ts", import.meta.url),
      maxWorkers: 1,
      idleTimeoutMs: 0,
    },
    { retainedTransport: true },
  );
  pools.push(pool);
  const context = new AsyncLocalStorage<string>();
  const callbacks: Array<string | undefined> = [];
  const consumed: Array<string | undefined> = [];
  const first = context.run("first", () =>
    pool.startTask(
      { label: "first", exchanges: 1 },
      {
        onRequestSync(value) {
          expect(value).toMatchObject({ label: "first" });
          callbacks.push(context.getStore());
          return {
            input: null,
            timeoutMs: 5_000,
            onConsumed: () => consumed.push(context.getStore()),
          };
        },
      },
    ),
  );
  let promiseReaction = false;
  void first.result.then(
    () => {
      promiseReaction = true;
    },
    () => undefined,
  );
  const second = pool.startTask({ label: "second" }, {});
  context.run("second", () =>
    serviceUntil(
      () => second.service(),
      () => first.read().status !== "pending",
    ),
  );
  const firstReply = read(first);
  expect(firstReply.label).toBe("first");
  expect(callbacks).toEqual(["first"]);
  expect(consumed).toEqual(["first"]);
  expect(promiseReaction).toBe(false);
  read(first.release());
  const secondReply = read(second);
  expect(secondReply.label).toBe("second");
  expect(secondReply.threadId).toBe(firstReply.threadId);
  read(second.release({ retire: true }));
});
