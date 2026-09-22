import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Profiler } from "node:inspector";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import {
  controlGatewayProfile,
  measureGatewayCpuUsage,
  readGatewayCpuUsage,
  readGatewayHeapProfile,
  readGatewayResources,
} from "../../scripts/lib/gateway-bench-profile.js";
import { requireNodeTool } from "../helpers/node-toolchain.js";

const nodeExecutable = requireNodeTool("node");

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
  const child = spawn(
    nodeExecutable,
    [fileURLToPath(new URL("./fixtures/gateway-bench-cpu-usage.mjs", import.meta.url))],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
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
  });
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
  const before = await readGatewayCpuUsage(child);
  const mainCompleted = once(child, "message");
  child.send({ run: "main" });
  const [mainResult] = await mainCompleted;
  expect(mainResult, stderr).toMatchObject({ completed: 1, checksum: expect.any(Number) });
  const afterMain = await readGatewayCpuUsage(child);
  const mainUsage = measureGatewayCpuUsage(before, afterMain);

  expect(mainUsage.pid).toBe(child.pid);
  expect(mainUsage.wallMs).toBeGreaterThan(0);
  expect(mainUsage.mainThread.totalMs).toBeGreaterThan(0);
  // Startup performs more fixed work than this window; cumulative counters would include it.
  expect(mainUsage.mainThread.totalMs).toBeLessThan(
    (before.mainThread.user + before.mainThread.system) / 1_000,
  );

  const workerCompleted = once(child, "message");
  child.send({ run: "worker" });
  const [workerResult] = await workerCompleted;
  expect(workerResult, stderr).toMatchObject({
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
  const child = spawn(
    nodeExecutable,
    ["-e", `process.on("message", () => process.${action}()); process.send({ ready: true });`],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const closed = once(child, "close");
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    await closed;
  });
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
    const child = spawn(
      nodeExecutable,
      [
        fileURLToPath(new URL("./fixtures/gateway-bench-profile-startup.mjs", import.meta.url)),
        directory,
        String(unknownIdentity),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const closed = once(child, "close");
    let cleanupPending: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPending ??= (async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
        await closed;
        await rm(directory, { recursive: true, force: true });
      })());
    onTestFinished(cleanup);
    try {
      const [code, signal] = await closed;
      expect({ code, signal }, stderr).toEqual({ code: 0, signal: null });
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
    } finally {
      await cleanup();
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
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", finish);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onMessage = (message: Record<string, unknown>) => {
      if (message[field]) {
        finish();
      }
    };
    const onExit = () => finish(new Error(`Profile fixture exited before ${field}`));
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", finish);
  });
}

it.each([
  ["cpu", false],
  ["heap", false],
  ["cpu", true],
  ["heap", true],
] as const)(
  "maps %s profiles to native workers with preexisting=%s and records retirement",
  async (kind, preexisting) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-worker-profile-"));
    const profilePath = path.join(directory, kind);
    const child = spawn(
      nodeExecutable,
      [
        "-e",
        workload,
        new URL("../../scripts/lib/gateway-bench-profile-preload.ts", import.meta.url).href,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    try {
      await waitMessage(child, "ready");
      if (preexisting) {
        const prepared = waitMessage(child, "prepared");
        child.send({ prepare: true });
        await prepared;
      }
      await controlGatewayProfile(child, kind, "start", profilePath, { includeWorkers: true });
      const complete = once(child, "message");
      child.send({ run: true });
      const [completed] = await complete;
      expect(completed.complete).toBe(true);
      await controlGatewayProfile(child, kind, "stop", profilePath, { includeWorkers: true });
      const manifest: WorkerProfileManifest = JSON.parse(
        await readFile(`${profilePath}.workers.json`, "utf8"),
      );
      expect(manifest).toMatchObject({
        kind,
        sampleClock: "performance.now",
        cpuCounters: "cumulative-microseconds",
      });
      expect(manifest.workers).toHaveLength(preexisting ? 2 : 1);
      const threadIds = manifest.workers.map((recording) => recording.threadId);
      const inspectorWorkerIds = manifest.workers.map((recording) => recording.inspectorWorkerId);
      const profilePaths = manifest.workers.map((recording) => recording.profilePath);
      for (const values of [threadIds, inspectorWorkerIds, profilePaths]) {
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
          const profile: Profiler.Profile = JSON.parse(
            await readFile(recording.profilePath, "utf8"),
          );
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
      expect(
        manifest.samples.some((sample) =>
          sample.workers.some(
            (worker) =>
              worker.threadId === completed.threadId &&
              worker.error === undefined &&
              Number.isFinite(worker.cpu?.user) &&
              Number.isFinite(worker.cpu?.system) &&
              Number.isFinite(worker.heap?.total_heap_size) &&
              Number.isFinite(worker.heap?.used_heap_size),
          ),
        ),
      ).toBe(true);
      expect(await readFile(profilePath, "utf8")).not.toBe("");

      const retiredPath = path.join(directory, `${kind}-retired`);
      await controlGatewayProfile(child, kind, "start", retiredPath, { includeWorkers: true });
      const retired = waitMessage(child, "retired");
      child.send({ retire: true });
      await retired;
      await controlGatewayProfile(child, kind, "stop", retiredPath, { includeWorkers: true });
      const incomplete: WorkerProfileManifest = JSON.parse(
        await readFile(`${retiredPath}.workers.json`, "utf8"),
      );
      expect(
        incomplete.workers
          .map(({ threadId, inspectorWorkerId }) => ({ threadId, inspectorWorkerId }))
          .toSorted((left, right) => left.threadId - right.threadId),
      ).toEqual(
        manifest.workers
          .map(({ threadId, inspectorWorkerId }) => ({ threadId, inspectorWorkerId }))
          .toSorted((left, right) => left.threadId - right.threadId),
      );
      for (const recording of incomplete.workers) {
        expect(recording.completed).not.toBe(true);
        expect(recording.error).toBeTruthy();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
