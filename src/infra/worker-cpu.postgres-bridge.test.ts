import { once } from "node:events";
import { BroadcastChannel, MessageChannel, Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { declarePostgresTestRoot } from "../../test/helpers/postgres-pool-roots.js";
import { createPostgresBridge } from "./postgres-sync/bridge-prestart.js";
import {
  closePostgresPool,
  createPostgresPoolEndpoints,
  postgresPoolTransferList,
} from "./postgres-sync/pool.js";
import { resolveRuntimeWorkerThreadExecArgv } from "./runtime-worker-url.js";
import {
  createCpuTrackedWorker,
  getTrackedWorkerPoolSnapshot,
  sampleTrackedWorkerMemory,
  trackNativeWorkerForCpu,
} from "./worker-cpu.js";
import { waitForWorkerMemoryPort } from "./worker-memory-port.test-support.js";
import {
  collectPostgresBridgeCounters,
  countPostgresBridges,
  countPostgresPoolSelfRoots,
} from "./worker-postgres-bridge-census.js";

it("counts four physical services across direct and deeply nested logical bridges", async () => {
  const before = getTrackedWorkerPoolSnapshot();
  const baseline = before.postgresBridgeCount ?? 0;
  const { port1, port2 } = new MessageChannel();
  const direct = createPostgresBridge({
    url: "postgres://localhost/bridge_census_fixture",
    schema: "fixture",
    storeId: "fixture",
  });
  const selfRoots = getTrackedWorkerPoolSnapshot().postgresPoolSelfRootCount;
  const postgresPool = createPostgresPoolEndpoints();
  const workerUrl = new URL("./worker-cpu.postgres-bridge.test-support.ts", import.meta.url);
  const parent = createCpuTrackedWorker(workerUrl, {
    workerData: { control: port2, depth: 2, postgresPool },
    transferList: [port2, ...postgresPoolTransferList(postgresPool)],
    execArgv: resolveRuntimeWorkerThreadExecArgv(workerUrl),
  });
  const attached = waitForWorkerMemoryPort(parent);
  const command = async (value: "create" | "close" | "nest" | "unnest") => {
    const reply = once(port1, "message");
    port1.postMessage(value);
    return (await reply)[0];
  };
  try {
    await attached;
    expect(await command("create")).toBe(1);
    expect(await command("create")).toBe(2);
    expect(getTrackedWorkerPoolSnapshot()).toMatchObject({
      workerCount: before.workerCount + 5,
      postgresBridgeCount: baseline + 4,
      postgresPoolSelfRootCount: selfRoots,
    });
    expect(sampleTrackedWorkerMemory().postgresBridgeCount).toBe(baseline + 4);

    // Logical close and host retirement preserve services used by other owners.
    expect(await command("close")).toBe(1);
    expect(getTrackedWorkerPoolSnapshot().postgresBridgeCount).toBe(baseline + 4);

    expect(await command("unnest")).toBe(0);
    expect(await command("nest")).toBe(0);
    expect(await command("create")).toBe(1);

    await parent.terminate();
    expect(sampleTrackedWorkerMemory().postgresBridgeCount).toBe(baseline + 4);
    direct.port.close();
    await closePostgresPool();
    expect(getTrackedWorkerPoolSnapshot()).toMatchObject({
      workerCount: before.workerCount,
      postgresBridgeCount: baseline,
    });
  } finally {
    port1.close();
    direct.port.close();
    await parent.terminate();
    await closePostgresPool();
  }
});

it("lets an explicitly declared external worker own four services and reports its self-root once", async () => {
  const { port1, port2 } = new MessageChannel();
  const diagnostics = new BroadcastChannel("openclaw.postgres.pool.self-root");
  const reported = Promise.withResolvers<{ threadId: number; owner: string }>();
  const url = new URL("./worker-cpu.postgres-bridge.test-support.ts", import.meta.url);
  const worker = new Worker(url, {
    workerData: { control: port2, depth: 0 },
    transferList: [port2],
    execArgv: resolveRuntimeWorkerThreadExecArgv(url),
  });
  declarePostgresTestRoot(worker.threadId);
  trackNativeWorkerForCpu(worker, url);
  diagnostics.addEventListener("message", ({ data }) => {
    if (data.threadId === worker.threadId) {
      reported.resolve(data);
    }
  });
  const attached = waitForWorkerMemoryPort(worker);
  const command = async (value: "create" | "close" | "restart" | "snapshot") => {
    const reply = once(port1, "message");
    port1.postMessage(value);
    return (await reply)[0];
  };
  try {
    await attached;
    expect(await command("create")).toBe(1);
    expect(await reported.promise).toMatchObject({ threadId: worker.threadId });
    expect(await command("create")).toBe(2);
    expect(await command("close")).toBe(1);
    expect(await command("snapshot")).toMatchObject({
      postgresBridgeCount: 4,
      postgresPoolSelfRootCount: 1,
      selfRootEvents: 1,
    });
    expect(await command("restart")).toBe(1);
    expect(await command("snapshot")).toMatchObject({
      postgresBridgeCount: 4,
      postgresPoolSelfRootCount: 1,
      selfRootEvents: 1,
    });
    const failed = once(worker, "error");
    port1.postMessage("undeclared");
    const [error] = await failed;
    expect(error.message).toContain("Undeclared PostgreSQL pool self-root: undeclared-fixture");
  } finally {
    diagnostics.close();
    port1.close();
    await worker.terminate();
  }
});

it("counts a shared counter once when multiple diagnostic sources forward it", () => {
  const descendant = {
    threadId: 9001,
    count: new Int32Array(new SharedArrayBuffer(4)),
    selfRootCount: new Int32Array(new SharedArrayBuffer(4)),
  };
  Atomics.store(descendant.count, 0, 3);
  Atomics.store(descendant.selfRootCount, 0, 1);
  const forwarded = structuredClone(descendant);
  expect(forwarded.count.buffer).not.toBe(descendant.count.buffer);
  const counters = collectPostgresBridgeCounters(new Int32Array(new SharedArrayBuffer(4)), [
    { postgresBridgeCounters: [descendant] },
    { postgresBridgeCounters: [forwarded] },
  ]);
  expect(countPostgresBridges(counters)).toBe(3);
  expect(countPostgresPoolSelfRoots(counters)).toBe(1);
  expect(countPostgresPoolSelfRoots([{ threadId: 9002, count: descendant.count }])).toBe(0);
});
