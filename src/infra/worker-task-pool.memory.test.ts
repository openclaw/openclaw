import { once } from "node:events";
import { cachedDataVersionTag } from "node:v8";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { expect, it } from "vitest";
import { WorkerTaskPool } from "./worker-task-pool.js";

it("collects a completed large payload while keeping the bounded worker warm", async () => {
  const cacheVersion = cachedDataVersionTag();
  const pool = new WorkerTaskPool<
    { receipt?: MessagePort },
    {
      heap: number;
      threadId: number;
      checksum?: number;
      resourceLimits: { maxOldGenerationSizeMb?: number };
    }
  >({
    workerUrl: new URL("./worker-task-pool.memory.test-support.ts", import.meta.url),
    workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 512 } },
    maxWorkers: 1,
  });
  const warmPorts = new MessageChannel();
  const { port1, port2 } = new MessageChannel();
  try {
    // A disposable payload guarantees collection before measuring the warm baseline.
    const warmed = once(warmPorts.port1, "message");
    const startup = await pool.run(
      { receipt: warmPorts.port2 },
      { transferList: () => [warmPorts.port2] },
    );
    const [warm] = await warmed;
    const collected = once(port1, "message");
    const allocated = await pool.run({ receipt: port2 }, { transferList: () => [port2] });
    const [idle] = await collected;
    expect(allocated.checksum).toBe(74);
    expect(allocated.heap).toBeGreaterThan(warm.heap + 100 * 1024 * 1024);
    expect(idle.heap).toBeLessThan(warm.heap + 32 * 1024 * 1024);
    expect(cachedDataVersionTag()).toBe(cacheVersion);
    const reused = await pool.run({}, {});
    expect(reused.threadId).toBe(warm.threadId);
    expect(reused.resourceLimits.maxOldGenerationSizeMb).toBe(512);
    console.info(
      JSON.stringify({
        warm: warm.heap,
        startup: startup.heap,
        allocated: allocated.heap,
        idle: idle.heap,
      }),
    );
  } finally {
    warmPorts.port1.close();
    warmPorts.port2.close();
    port1.close();
    port2.close();
    await pool.close();
  }
});
