import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type {
  AdmissionTaskInput,
  AdmissionTaskResult,
} from "./sqlite-database-admission.task.test-support.js";
import { createOwnedWorkerTaskPool } from "./worker-task-pool.js";
import type {
  ResourceFixtureInput,
  ResourceFixtureReply,
} from "./worker-task-pool.resources.test-support.js";
import type { PoolFixtureInput, PoolFixtureResult } from "./worker-task-pool.test-support.js";

const pools: Array<{ close(): Promise<void> }> = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

it("preserves workerData through retained task startup", async () => {
  const workerData = { type: "user data", port: "user port" };
  const pool = createOwnedWorkerTaskPool<PoolFixtureInput, PoolFixtureResult>(
    {
      workerUrl: new URL("./worker-task-pool.test-support.ts", import.meta.url),
      workerOptions: { workerData },
      maxWorkers: 1,
      idleTimeoutMs: 0,
    },
    { retainedTransport: true },
  );
  pools.push(pool);
  const reply = await pool.run({ label: "startup", readStartupOptions: true }, {});
  expect(reply.startupOptions?.data).toEqual(workerData);
});

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

it("services a sibling pool's database facts while the host event loop is blocked", async () => {
  const blockedPool = fixture();
  const admissionPool = createOwnedWorkerTaskPool<AdmissionTaskInput, AdmissionTaskResult>(
    {
      workerUrl: new URL("./sqlite-database-admission.task.test-support.ts", import.meta.url),
      maxWorkers: 1,
      idleTimeoutMs: 0,
    },
    { retainedTransport: true },
  );
  pools.push(admissionPool);
  await Promise.all([blockedPool.run({}, {}), admissionPool.run({}, {})]);
  const location = path.join(tempDirs.make("cross-pool-admission-"), "shared.sqlite");
  const database = new DatabaseSync(location);
  database.exec("CREATE TABLE proof (value INTEGER)");
  database.close();
  const barrier = new Int32Array(new SharedArrayBuffer(8));
  const blocked = blockedPool.startTask({ wait: barrier.buffer }, {});
  const admission = admissionPool.startTask({ path: location }, {});
  let promiseReaction = false;
  void admission.result.then(
    () => {
      promiseReaction = true;
    },
    () => undefined,
  );
  try {
    serviceUntil(
      () => blocked.service(),
      () => admission.read().status !== "pending",
    );
    expect(read(admission).sql.some((sql) => sql.includes("sqlite_schema"))).toBe(true);
    expect(promiseReaction).toBe(false);
  } finally {
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1);
    read(admission.release());
    read(blocked);
    read(blocked.release());
  }
});

function ordinaryFixture() {
  const pool = createOwnedWorkerTaskPool<ResourceFixtureInput, ResourceFixtureReply>({
    workerUrl: new URL("./worker-task-pool.resources.test-support.ts", import.meta.url),
    maxWorkers: 1,
  });
  pools.push(pool);
  const run = async (input: ResourceFixtureInput) => {
    const task = pool.runTask(input, {});
    try {
      return await task.result;
    } finally {
      await task.close();
    }
  };
  return { pool, run };
}

it("serializes resource cleanup after an asynchronous task without cancelling it", async () => {
  const { pool, run } = ordinaryFixture();
  const first = await run({ retain: "source" });
  const barrier = new Int32Array(new SharedArrayBuffer(8));
  const task = pool.runTask({ wait: barrier.buffer }, {});
  await expect.poll(() => Atomics.load(barrier, 0)).toBe(1);
  let closed = false;
  const cleanup = pool.closeResources("source").then(() => {
    closed = true;
  });
  try {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(closed).toBe(false);
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1);
    expect(await task.result).toEqual({ keys: ["source"], threadId: first.threadId });
    await cleanup;
    expect(closed).toBe(true);
  } finally {
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1);
    await task.close();
    await cleanup;
  }
  expect(await run({})).toEqual({ keys: [], threadId: first.threadId });
});
