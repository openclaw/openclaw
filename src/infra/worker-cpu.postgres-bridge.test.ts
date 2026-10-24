import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { expect, it } from "vitest";
import { createPostgresBridge } from "./postgres-sync/bridge-prestart.js";
import { resolveRuntimeWorkerThreadExecArgv } from "./runtime-worker-url.js";
import {
  createCpuTrackedWorker,
  getTrackedWorkerPoolSnapshot,
  receiveWorkerMemoryPort,
  sampleTrackedWorkerMemory,
} from "./worker-cpu.js";

it("counts direct and nested PostgreSQL bridges until their native owners exit", async () => {
  const before = getTrackedWorkerPoolSnapshot();
  const baseline = before.postgresBridgeCount ?? 0;
  const { port1, port2 } = new MessageChannel();
  const workerUrl = new URL("./worker-cpu.postgres-bridge.test-support.ts", import.meta.url);
  const parent = createCpuTrackedWorker(workerUrl, {
    workerData: { control: port2 },
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
  const command = async (value: "create" | "close") => {
    const reply = once(port1, "message");
    port1.postMessage(value);
    return (await reply)[0];
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
