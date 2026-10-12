import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { workerTaskPoolEntrypoints } from "./worker-task-pool-runtime.test-support.js";
import { WorkerTaskPool } from "./worker-task-pool.js";
import type { PoolFixtureInput, PoolFixtureResult } from "./worker-task-pool.test-support.js";

it("delivers synchronous notifications without settling work or consuming input", async ({
  signal,
}) => {
  const pool = new WorkerTaskPool<PoolFixtureInput, PoolFixtureResult>({
    workerUrl: resolveRuntimeWorkerUrl(workerTaskPoolEntrypoints.worker),
    maxWorkers: 1,
  });
  const counter = new Int32Array(new SharedArrayBuffer(8));
  const received = createDeferred();
  const values: unknown[] = [];
  const consumed = vi.fn();
  const work = pool.run(
    {
      label: "progress",
      notifications: 3,
      counters: counter.buffer,
      wait: true,
      consumeInput: true,
    },
    {
      onNotification(value) {
        values.push(value);
        if (values.length === 3) {
          received.resolve();
        }
      },
      onInputConsumed: consumed,
    },
  );
  try {
    await withinTest(received.promise, signal);
    expect(values).toEqual([0, 1, 2].map((index) => ({ label: "progress", index })));
    expect(consumed).not.toHaveBeenCalled();
    expect(pool.getSnapshot().activeTasks).toBe(1);
    Atomics.store(counter, 1, 1);
    Atomics.notify(counter, 1);
    await expect(withinTest(work, signal)).resolves.toMatchObject({ label: "progress" });
    expect(consumed).toHaveBeenCalledOnce();
  } finally {
    Atomics.store(counter, 1, 1);
    Atomics.notify(counter, 1);
    await pool.close();
  }
});
