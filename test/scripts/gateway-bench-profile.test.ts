import { spawn, type ChildProcess } from "node:child_process";
import { on, once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Profiler } from "node:inspector";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import {
  controlGatewayProfile,
  measureGatewayCpuUsage,
  measureGatewayAllocations,
  readGatewayCpuUsage,
  readGatewayHeapProfile,
  readGatewayResources,
} from "../../scripts/lib/gateway-bench-profile.js";
import { requireNodeTool } from "../helpers/node-toolchain.js";

const nodeExecutable = requireNodeTool("node");
const preloadUrl = new URL("../../scripts/lib/gateway-bench-profile-preload.ts", import.meta.url)
  .href;
const fixturePath = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}.mjs`, import.meta.url));
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, "utf8"));

function spawnFixture(args: string[], directory?: string, ipc = true) {
  const child = spawn(nodeExecutable, args, {
    stdio: ipc ? ["ignore", "ignore", "pipe", "ipc"] : ["ignore", "ignore", "pipe"],
  });
  const closed = once(child, "close");
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    await closed;
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  });
  return { child, closed, stderr: () => stderr };
}

async function sendMessage(child: ChildProcess, message: object) {
  const received = once(child, "message");
  child.send(message);
  return (await received)[0];
}

const workerIdentities = (manifest: WorkerProfileManifest) =>
  manifest.workers
    .map(({ threadId, inspectorWorkerId }) => ({ threadId, inspectorWorkerId }))
    .toSorted((left, right) => left.threadId - right.threadId);

type WorkerProfileManifest = {
  workers: Array<{
    completed?: boolean;
    error?: string;
    inspectorWorkerId: string;
    profilePath: string;
    threadId: number;
  }>;
  samples: Array<{
    workers: Array<{
      threadId: number;
      cpu?: NodeJS.CpuUsage;
      heap?: { total_heap_size: number; used_heap_size: number };
      error?: string;
    }>;
  }>;
};

it("measures fixed CPU work including a retired Worker without starting the inspector", async () => {
  const { child, stderr } = spawnFixture([fixturePath("gateway-bench-cpu-usage")]);
  await waitMessage(child, "ready");
  const initialResources = await readGatewayResources(child, { initial: true });
  const resources = await readGatewayResources(child);
  expect(resources.pid).toBe(child.pid);
  expect(initialResources.atMonotonicMicros).toBeLessThan(resources.atMonotonicMicros);
  expect(resources.runtime).toMatchObject({ node: expect.any(String), platform: process.platform });
  for (const value of Object.values(resources.memory)) {
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
  const changeTimer = async (run: string) => {
    expect(await sendMessage(child, { run })).toEqual({ timerChanged: true });
    return await readGatewayResources(child);
  };
  const held = await changeTimer("timer-start");
  const released = await changeTimer("timer-stop");
  expect(held.activeResources.Timeout).toBe((resources.activeResources.Timeout ?? 0) + 1);
  expect(released.activeResources.Timeout ?? 0).toBe(resources.activeResources.Timeout ?? 0);
  const before = await readGatewayCpuUsage(child);
  const mainResult = await sendMessage(child, { run: "main" });
  expect(mainResult, stderr()).toMatchObject({ completed: 1, checksum: expect.any(Number) });
  const afterMain = await readGatewayCpuUsage(child);
  const mainUsage = measureGatewayCpuUsage(before, afterMain);

  expect(mainUsage.pid).toBe(child.pid);
  expect(mainUsage.wallMs).toBeGreaterThan(0);
  expect(mainUsage.mainThread.totalMs).toBeGreaterThan(0);
  // Startup performs more fixed work than this window; cumulative counters would include it.
  expect(mainUsage.mainThread.totalMs).toBeLessThan(
    (before.mainThread.user + before.mainThread.system) / 1_000,
  );

  const workerResult = await sendMessage(child, { run: "worker" });
  expect(workerResult, stderr()).toMatchObject({
    completed: 1,
    workerRetired: true,
    checksum: mainResult.checksum,
  });
  const afterWorker = await readGatewayCpuUsage(child);
  const workerUsage = measureGatewayCpuUsage(afterMain, afterWorker);
  expect(workerUsage.process.totalMs).toBeGreaterThan(workerUsage.mainThread.totalMs);
  expect(workerUsage.process.totalMs).toBeGreaterThanOrEqual(workerResult.workerCpuMicros / 1_000);
}, 30_000);

it.each(["exit", "disconnect"])("rejects a CPU sample when the child %ss", async (action) => {
  const { child, closed } = spawnFixture([
    "-e",
    `process.on("message", () => process.${action}()); process.send({ ready: true });`,
  ]);
  await waitMessage(child, "ready");
  await expect(readGatewayCpuUsage(child)).rejects.toThrow(/Gateway (exited|disconnected)/);
  await closed;
  for (const event of ["message", "exit", "disconnect", "error"]) {
    expect(child.listenerCount(event)).toBe(0);
  }
});

it.each([false, true])(
  "settles startup profiling across builtin initialization with unknown identity=%s",
  async (unknownIdentity) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-worker-profile-startup-"));
    const { closed, stderr } = spawnFixture(
      [fixturePath("gateway-bench-profile-startup"), directory, String(unknownIdentity)],
      directory,
      false,
    );
    const [code, signal] = await closed;
    expect({ code, signal }, stderr()).toEqual({ code: 0, signal: null });
    const { threadId, manifest, samplerStopProbe } = JSON.parse(
      await readFile(path.join(directory, "result.json"), "utf8"),
    );
    expect(manifest.workers).toHaveLength(1);
    if (unknownIdentity) {
      expect(manifest.workers[0].completed).not.toBe(true);
      expect(manifest.workers[0].threadId).toBeUndefined();
      expect(manifest.workers[0].error).toBeTruthy();
      expect(samplerStopProbe.error.message).toMatch(/not started/i);
    } else {
      expect(manifest.workers[0]).toMatchObject({ completed: true, threadId });
      expect(manifest.workers[0].inspectorWorkerId).not.toBe(String(threadId));
      expect(await readFile(manifest.workers[0].profilePath, "utf8")).toContain(
        "allocateAtStartup",
      );
    }
  },
  30_000,
);

const workload = `
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const keepAlive = setInterval(() => {}, 1000);
process.once('disconnect', () => clearInterval(keepAlive));
let worker, idle;
function createWorker() {
    worker = new Worker(\`
      const { parentPort } = require('node:worker_threads');
      let total = 0;
      function allocateForProfile() {
        const until = Date.now() + 500;
        while (Date.now() < until) {
          const rows = Array.from({length: 10000}, (_, i) => ({i, values: [i, i + 1]}));
          total += rows[rows.length - 1].values[1];
        }
        parentPort.postMessage(total);
      }
      parentPort.on('message', allocateForProfile);
    \`, {eval: true, execArgv: []});
    worker.once('message', () => process.send({complete: true, threadId: worker.threadId}));
}
process.on('message', (message) => {
  if (message.prepare) {
    idle = new Worker('setInterval(() => {}, 1000)', {eval: true, execArgv: []});
    createWorker();
    Promise.all([once(idle, 'online'), once(worker, 'online')]).then(() => process.send({prepared: true}));
  }
  if (message.run) {
    if (worker) worker.postMessage('run');
    else {
      createWorker();
      worker.once('online', () => worker.postMessage('run'));
    }
  }
  if (message.retire) Promise.all([worker, idle].filter(Boolean).map(w => w.terminate()))
    .then(() => process.send({retired: true}));
});
(async () => {
  // A retired worker consumes a native ID before the inspector allocates any target IDs.
  const retired = new Worker('', {eval: true, execArgv: []});
  await once(retired, 'exit');
  await import(process.argv[1]);
  process.send({ready: true});
})();
`;

async function waitMessage(child: ChildProcess, field: string) {
  for await (const [message] of on(child, "message", { close: ["exit"] })) {
    if (message[field]) {
      return;
    }
  }
  throw new Error(`Profile fixture exited before ${field}`);
}

it.each([
  ["cpu", false],
  ["heap", true],
] as const)(
  "maps %s profiles to native workers with preexisting=%s and records retirement",
  async (kind, preexisting) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-worker-profile-"));
    const profilePath = path.join(directory, kind);
    const { child } = spawnFixture(["-e", workload, preloadUrl], directory);
    await waitMessage(child, "ready");
    if (preexisting) {
      expect(await sendMessage(child, { prepare: true })).toMatchObject({ prepared: true });
    }
    await controlGatewayProfile(child, kind, "start", profilePath, { includeWorkers: true });
    const completed = await sendMessage(child, { run: true });
    expect(completed.complete).toBe(true);
    await controlGatewayProfile(child, kind, "stop", profilePath, { includeWorkers: true });
    const manifest = await readJson<WorkerProfileManifest>(`${profilePath}.workers.json`);
    expect(manifest).toMatchObject({
      kind,
      sampleClock: "performance.now",
      cpuCounters: "cumulative-microseconds",
    });
    expect(manifest.workers).toHaveLength(preexisting ? 2 : 1);
    for (const key of ["threadId", "inspectorWorkerId", "profilePath"] as const) {
      const values = manifest.workers.map((recording) => recording[key]);
      expect(new Set<string | number>(values).size).toBe(manifest.workers.length);
    }
    const profiledThreadIds: number[] = [];
    for (const recording of manifest.workers) {
      expect(recording).toMatchObject({
        completed: true,
        inspectorWorkerId: expect.any(String),
        threadId: expect.any(Number),
      });
      expect(recording.error).toBeUndefined();
      if (kind === "cpu") {
        const profile = await readJson<Profiler.Profile>(recording.profilePath);
        if (profile.nodes.some((node) => node.callFrame.functionName === "allocateForProfile")) {
          expect(profile.samples?.length ?? 0).toBeGreaterThan(0);
          expect(profile.endTime).toBeGreaterThan(profile.startTime);
          profiledThreadIds.push(recording.threadId);
        }
      } else {
        const profile = readGatewayHeapProfile(recording.profilePath);
        if (
          profile.topAllocationSites.some((site) =>
            site.stack.some((frame) => frame.startsWith("allocateForProfile (")),
          )
        ) {
          expect(profile.sampledAllocatedBytes).toBeGreaterThan(0);
          profiledThreadIds.push(recording.threadId);
        }
      }
    }
    expect(profiledThreadIds).toEqual([completed.threadId]);
    const samples = manifest.samples.flatMap((sample) => sample.workers);
    expect(
      samples.some(
        ({ threadId, error, cpu, heap }) =>
          threadId === completed.threadId &&
          error === undefined &&
          [cpu?.user, cpu?.system, heap?.total_heap_size, heap?.used_heap_size].every(
            Number.isFinite,
          ),
      ),
    ).toBe(true);
    expect(await readFile(profilePath, "utf8")).not.toBe("");

    const retiredPath = path.join(directory, `${kind}-retired`);
    await controlGatewayProfile(child, kind, "start", retiredPath, { includeWorkers: true });
    expect(await sendMessage(child, { retire: true })).toMatchObject({ retired: true });
    await controlGatewayProfile(child, kind, "stop", retiredPath, { includeWorkers: true });
    const incomplete = await readJson<WorkerProfileManifest>(`${retiredPath}.workers.json`);
    expect(workerIdentities(incomplete)).toEqual(workerIdentities(manifest));
    for (const recording of incomplete.workers) {
      expect(recording.completed).not.toBe(true);
      expect(recording.error).toBeTruthy();
    }
  },
  30_000,
);

it("measures discarded allocation churn and GC per completed operation, and cleans up failures", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-allocation-"));
  const { child } = spawnFixture(
    [
      "--expose-gc",
      "--input-type=module",
      "-e",
      `
    await import(${JSON.stringify(preloadUrl)});
    process.channel.ref();
    function discardedAllocation() {
      let checksum = 0;
      for (let batch = 0; batch < 10; batch++) {
        const rows = Array.from({ length: 20000 }, (_, i) => ({ i, values: [i, i + 1] }));
        checksum += rows[rows.length - 1].values[1];
      }
      return checksum;
    }
    process.on('message', async message => {
      if (!message.run) return;
      for (let operation = 0; operation < 4; operation++) discardedAllocation();
      globalThis.gc();
      await new Promise(setImmediate);
      await new Promise(setImmediate);
      process.send({ completed: 4 });
    });
    process.send({ ready: true });
  `,
    ],
    directory,
  );
  await waitMessage(child, "ready");
  const measure = (name: string, count: number, run: () => Promise<void>) =>
    measureGatewayAllocations(child, path.join(directory, name), count, run);
  await expect(
    measure("failed", 1, async () => {
      throw new Error("workload failed");
    }),
  ).rejects.toThrow("workload failed");
  const result = await measure("completed", 4, async () => {
    expect(await sendMessage(child, { run: true })).toEqual({ completed: 4 });
  });
  expect(result).toMatchObject({
    scope: "main-isolate",
    includesCollectedObjects: true,
    cpu: { pid: child.pid },
  });
  expect(result.estimatedAllocatedBytesPerOperation).toBeGreaterThan(1_000_000);
  expect(result.gcMsPerOperation).toBeGreaterThan(0);
  expect(result.gcCount).toBeGreaterThan(0);
  expect(
    result.topAllocationSites.some((site) =>
      site.stack.some((frame) => frame.startsWith("discardedAllocation (")),
    ),
  ).toBe(true);
});
