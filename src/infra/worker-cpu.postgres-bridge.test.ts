import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { expect, it } from "vitest";
import { createPostgresBridge } from "./postgres-sync/bridge-prestart.js";
import { resolveRuntimeWorkerThreadExecArgv } from "./runtime-worker-url.js";
import {
  createCpuTrackedWorker,
  getTrackedWorkerPoolSnapshot,
  observeTrackedPostgresBridgeCounters,
  receiveWorkerMemoryPort,
  sampleTrackedWorkerMemory,
} from "./worker-cpu.js";
import {
  collectPostgresBridgeCounters,
  countPostgresBridges,
} from "./worker-postgres-bridge-census.js";

it("counts direct and deeply nested PostgreSQL bridges until their native owners exit", async () => {
  const before = getTrackedWorkerPoolSnapshot();
  const baseline = before.postgresBridgeCount ?? 0;
  const { port1, port2 } = new MessageChannel();
  const workerUrl = new URL("./worker-cpu.postgres-bridge.test-support.ts", import.meta.url);
  const parent = createCpuTrackedWorker(workerUrl, {
    workerData: { control: port2, depth: 2 },
    transferList: [port2],
    execArgv: resolveRuntimeWorkerThreadExecArgv(workerUrl),
  });
  const attached = new Promise<void>((resolve, reject) => {
    parent.on("message", (message: unknown) => {
      if (receiveWorkerMemoryPort(parent, message)) {
        resolve();
      }
    });
    parent.once("error", reject);
  });
  const direct = createPostgresBridge({
    url: "postgres://localhost/bridge_census_fixture",
    schema: "fixture",
    storeId: "fixture",
  });
  const command = async (value: "create" | "close" | "nest" | "unnest") => {
    const reply = once(port1, "message");
    port1.postMessage(value);
    return (await reply)[0];
  };
  const commandWithCount = async (value: "create" | "nest" | "unnest", expected: number) => {
    const reached = Promise.withResolvers<void>();
    const check = () => {
      if (getTrackedWorkerPoolSnapshot().postgresBridgeCount === expected) {
        reached.resolve();
      }
    };
    const stop = observeTrackedPostgresBridgeCounters(check);
    try {
      const reply = await command(value);
      check();
      await reached.promise;
      return reply;
    } finally {
      stop();
    }
  };
  try {
    await attached;
    expect(await command("create")).toBe(1);
    expect(await command("create")).toBe(2);
    expect(getTrackedWorkerPoolSnapshot()).toMatchObject({
      workerCount: before.workerCount + 2,
      postgresBridgeCount: baseline + 3,
    });
    expect(sampleTrackedWorkerMemory().postgresBridgeCount).toBe(baseline + 3);

    // No new memory sample is needed: native bridge exit updates the shared census.
    expect(await command("close")).toBe(1);
    expect(getTrackedWorkerPoolSnapshot().postgresBridgeCount).toBe(baseline + 2);

    // A descendant's native exit removes its whole contribution while its parent stays alive.
    expect(await commandWithCount("unnest", baseline + 1)).toBe(0);
    expect(await command("nest")).toBe(0);
    expect(await commandWithCount("create", baseline + 2)).toBe(1);

    // Terminating the parent also joins its remaining bridge and releases its count.
    await parent.terminate();
    expect(sampleTrackedWorkerMemory().postgresBridgeCount).toBe(baseline + 1);
    direct.port.close();
    await direct.worker.terminate();
    expect(getTrackedWorkerPoolSnapshot()).toMatchObject({
      workerCount: before.workerCount,
      postgresBridgeCount: baseline,
    });
  } finally {
    port1.close();
    direct.port.close();
    await Promise.all([parent.terminate(), direct.worker.terminate()]);
  }
});

it("counts a shared counter once when multiple diagnostic sources forward it", () => {
  const descendant = { threadId: 9001, count: new Int32Array(new SharedArrayBuffer(4)) };
  Atomics.store(descendant.count, 0, 3);
  const forwarded = structuredClone(descendant);
  expect(forwarded.count.buffer).not.toBe(descendant.count.buffer);
  const counters = collectPostgresBridgeCounters(new Int32Array(new SharedArrayBuffer(4)), [
    { postgresBridgeCounters: [descendant] },
    { postgresBridgeCounters: [forwarded] },
  ]);
  expect(countPostgresBridges(counters)).toBe(3);
});
