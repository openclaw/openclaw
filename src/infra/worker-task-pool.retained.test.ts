import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { WorkerOptions } from "node:worker_threads";
import type { RetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  installDatabaseEngineSelection,
  withDatabaseEngineSelection,
} from "./database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "./database-engine/context.test-support.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
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
import type { WorkerTaskPoolOptions } from "./worker-task-pool.types.js";

const pools: Array<{ close(): Promise<void> }> = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  resetDatabaseEngineSelectionForTest();
});

function createPool<Input, Output>(
  file: string,
  retainedTransport = true,
  options: Partial<WorkerTaskPoolOptions<Output>> = {},
) {
  const pool = createOwnedWorkerTaskPool<Input, Output>(
    { workerUrl: new URL(file, import.meta.url), maxWorkers: 1, idleTimeoutMs: 0, ...options },
    retainedTransport ? { retainedTransport: true } : undefined,
  );
  pools.push(pool);
  return pool;
}

const taskFixture = (retained = true, workerOptions?: WorkerOptions) =>
  createPool<PoolFixtureInput, PoolFixtureResult>("./worker-task-pool.test-support.ts", retained, {
    workerOptions,
  });
const fixture = (retained = true) =>
  createPool<ResourceFixtureInput, ResourceFixtureReply>(
    "./worker-task-pool.resources.test-support.ts",
    retained,
    retained ? {} : { idleTimeoutMs: undefined },
  );

it.each([false, true])(
  "carries boot and offline selections through a reused task worker (retained: %s)",
  async (retainedTransport) => {
    const pool = taskFixture(retainedTransport);
    const run = () => pool.run({ label: "selection", readEngineSelection: true }, {});
    const prewarmed = await run();
    expect(prewarmed.engineSelection).toBeUndefined();
    const sqlite = { effectiveEngines: resolveDatabaseFamilyEngines({}) };
    const offline = await withDatabaseEngineSelection(sqlite, run);
    expect(offline).toMatchObject({ threadId: prewarmed.threadId, engineSelection: sqlite });
    expect((await run()).engineSelection).toBeUndefined();
    const selection = {
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: "postgresql://synthetic.invalid/r4", schemaPrefix: "r4" },
    };
    installDatabaseEngineSelection(selection);
    const selected = await run();
    expect(selected).toMatchObject({ threadId: prewarmed.threadId, engineSelection: selection });
    expect((await run()).engineSelection).toEqual(selection);
    for (const scoped of [
      sqlite,
      {
        effectiveEngines: { ...sqlite.effectiveEngines, state: "postgres" as const },
        postgres: { connection: "postgresql://synthetic.invalid/port", schemaPrefix: "port" },
      },
    ]) {
      const reply = await withDatabaseEngineSelection(scoped, run);
      expect(reply).toMatchObject({ threadId: prewarmed.threadId, engineSelection: scoped });
      expect((await run()).engineSelection).toEqual(selection);
    }
  },
);

it("preserves workerData through retained task startup", async () => {
  const workerData = { type: "user data", port: "user port" };
  const pool = taskFixture(true, { workerData });
  const reply = await pool.run({ label: "startup", readStartupOptions: true }, {});
  expect(reply.startupOptions?.data).toEqual(workerData);
});

const pause = new Int32Array(new SharedArrayBuffer(4));
function blockingInput() {
  const words = new Int32Array(new SharedArrayBuffer(8));
  return {
    input: { wait: words.buffer },
    entered: () => Atomics.load(words, 0) === 1,
    release() {
      Atomics.store(words, 1, 1);
      Atomics.notify(words, 1);
    },
  };
}
function serviceUntil(
  port: Pick<RetainedOperation<unknown>, "service">,
  ready: () => boolean,
): void {
  const deadline = performance.now() + 10_000;
  while (!ready()) {
    if (performance.now() >= deadline) {
      throw new Error("Retained worker operation did not settle");
    }
    port.service();
    Atomics.wait(pause, 0, 0, 1);
  }
}

function read<T>(operation: RetainedOperation<T>): T {
  serviceUntil(operation, () => operation.read().status !== "pending");
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
  const barrier = blockingInput();
  const promiseReaction = vi.fn();
  const start = (owner: string, input: ResourceFixtureInput) =>
    context.run(owner, () =>
      pool.startTask(input, { onExecutionSettled: () => settlements.push(context.getStore()) }),
    );
  const first = start("first", { retain: "first", ...barrier.input });
  const second = start("second", { retain: "second" });
  void first.result.then(promiseReaction);
  try {
    serviceUntil(second, barrier.entered);
    expect(second.read().status).toBe("pending");
    barrier.release();
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
    expect(promiseReaction).not.toHaveBeenCalled();
  } finally {
    barrier.release();
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
  const barrier = blockingInput();
  const blocked = pool.startTask(barrier.input, { timeoutMs: 500 });
  const successor = pool.startTask({ retain: "successor" }, {});
  try {
    serviceUntil(blocked, barrier.entered);
    expect(() => read(blocked)).toThrow("worker task timed out");
    read(blocked.release());
    const reply = read(successor);
    expect(reply.keys).toEqual(["successor"]);
    expect(reply.threadId).not.toBe(oldThread);
    read(successor.release({ retire: true }));
    expect(pool.getSnapshot().workers).toBe(0);
  } finally {
    barrier.release();
  }
});

it("answers an earlier task's synchronous host exchange while servicing a queued task", () => {
  const pool = taskFixture();
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
  const promiseReaction = vi.fn();
  void first.result.then(promiseReaction, () => undefined);
  const second = pool.startTask({ label: "second" }, {});
  context.run("second", () => serviceUntil(second, () => first.read().status !== "pending"));
  const firstReply = read(first);
  expect(firstReply.label).toBe("first");
  expect({ callbacks, consumed }).toEqual({ callbacks: ["first"], consumed: ["first"] });
  expect(promiseReaction).not.toHaveBeenCalled();
  read(first.release());
  const secondReply = read(second);
  expect(secondReply).toMatchObject({ label: "second", threadId: firstReply.threadId });
  read(second.release({ retire: true }));
});

it("services a sibling pool's database facts while the host event loop is blocked", async () => {
  const blockedPool = fixture();
  const admissionPool = createPool<AdmissionTaskInput, AdmissionTaskResult>(
    "./sqlite-database-admission.task.test-support.ts",
  );
  await Promise.all([blockedPool.run({}, {}), admissionPool.run({}, {})]);
  const location = path.join(tempDirs.make("cross-pool-admission-"), "shared.sqlite");
  const database = new DatabaseSync(location);
  database.exec("CREATE TABLE proof (value INTEGER)");
  database.close();
  const barrier = blockingInput();
  const blocked = blockedPool.startTask(barrier.input, {});
  const admission = admissionPool.startTask({ path: location }, {});
  const promiseReaction = vi.fn();
  void admission.result.then(promiseReaction, () => undefined);
  try {
    serviceUntil(blocked, () => admission.read().status !== "pending");
    expect(read(admission).sql.some((sql) => sql.includes("sqlite_schema"))).toBe(true);
    expect(promiseReaction).not.toHaveBeenCalled();
  } finally {
    barrier.release();
    read(admission.release());
    read(blocked);
    read(blocked.release());
  }
});

it("serializes resource cleanup after an asynchronous task without cancelling it", async () => {
  const pool = fixture(false);
  const run = (input: ResourceFixtureInput) => pool.run(input, {});
  const first = await run({ retain: "source" });
  const barrier = blockingInput();
  const task = pool.runTask(barrier.input, {});
  await expect.poll(barrier.entered).toBe(true);
  const closed = vi.fn();
  const cleanup = pool.closeResources("source").then(closed);
  try {
    await nextTurn();
    expect(closed).not.toHaveBeenCalled();
    barrier.release();
    expect(await task.result).toEqual({ keys: ["source"], threadId: first.threadId });
    await cleanup;
    expect(closed).toHaveBeenCalledOnce();
  } finally {
    barrier.release();
    await task.close();
    await cleanup;
  }
  expect(await run({})).toEqual({ keys: [], threadId: first.threadId });
});
