import { afterEach, expect, it } from "vitest";
import { createOwnedWorkerTaskPool } from "./worker-task-pool.js";
import type {
  ResourceFixtureInput,
  ResourceFixtureReply,
} from "./worker-task-pool.resources.test-support.js";

const pools: ReturnType<
  typeof createOwnedWorkerTaskPool<ResourceFixtureInput, ResourceFixtureReply>
>[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});
function fixture() {
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

it.each(["first", "fail-once"])(
  "cleans %s without retiring its worker or sibling resources",
  async (key) => {
    const { pool, run } = fixture();
    const first = await run({ retain: key });
    if (key === "fail-once") {
      await expect(pool.closeResources(key)).rejects.toThrow("Worker resource cleanup failed");
    } else {
      await run({ retain: "second" });
    }
    await pool.closeResources(key);
    if (key === "first") {
      expect(await run({})).toEqual({ keys: ["second"], threadId: first.threadId });
      await pool.closeResources();
    }
    expect(await run({})).toEqual({ keys: [], threadId: first.threadId });
  },
);

it("serializes resource cleanup after an asynchronous task without cancelling it", async () => {
  const { pool, run } = fixture();
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
