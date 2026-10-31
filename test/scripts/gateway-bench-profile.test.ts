import { spawn, type ChildProcess } from "node:child_process";
import { on, once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { HeapProfiler, Profiler } from "node:inspector";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import {
  controlGatewayProfile,
  measureGatewayCpuUsage,
  measureGatewayAllocations,
  readGatewayCpuUsage,
  readGatewayGcTrace,
  readGatewayHeapProfile,
  readGatewayResources,
  startGatewayDiagnostics,
} from "../../scripts/lib/gateway-bench-profile.js";
import type { startGatewayBenchWorkerMessages } from "../../scripts/lib/gateway-bench-worker-messages.js";
import { requireNodeTool } from "../helpers/node-toolchain.js";

const nodeExecutable = requireNodeTool("node");
const preloadUrl = new URL("../../scripts/lib/gateway-bench-profile-preload.ts", import.meta.url)
  .href;
const fixturePath = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}.mjs`, import.meta.url));
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, "utf8"));

function spawnFixture(args: string[], directory?: string, ipc = true, env?: NodeJS.ProcessEnv) {
  const child = spawn(nodeExecutable, args, {
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    env,
  });
  const closed = once(child, "close");
  let stderr = "";
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
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
  return { child, closed, stderr: () => stderr, stdout: () => stdout };
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
  samplingIntervalBytes?: number;
  includeCollectedObjects?: boolean;
  workers: Array<{
    completed?: boolean;
    error?: string;
    inspectorWorkerId: string;
    title: string;
    profilePath: string;
    script?: string;
    unregisteredWhileLive?: boolean;
    threadId: number;
    startedAt: number;
    samplingStartedAt?: number;
    samplingStoppedAt?: number;
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

function heapBytesUnder(
  node: HeapProfiler.SamplingHeapProfileNode,
  functionName: string,
  inside = false,
): number {
  const matches = inside || node.callFrame.functionName === functionName;
  return (
    (matches ? node.selfSize : 0) +
    node.children.reduce(
      (total, childNode) => total + heapBytesUnder(childNode, functionName, matches),
      0,
    )
  );
}

it("enables GC tracing without passing unsupported arguments to default Workers", async () => {
  const { closed, stdout, stderr } = spawnFixture(
    [
      "--import",
      preloadUrl,
      "--input-type=module",
      "-e",
      `
      const { Worker } = await import("node:worker_threads");
      const { once } = await import("node:events");
      const worker = new Worker('import("node:worker_threads").then(({ parentPort }) => parentPort.postMessage("ready"))', { eval: true });
      await once(worker, "message");
      await once(worker, "exit");
      process.disconnect();
      `,
    ],
    undefined,
    true,
    { ...process.env, OPENCLAW_BENCH_TRACE_GC: "1" },
  );
  expect(await closed, stderr()).toEqual([0, null]);
  expect(stdout()).toContain('"phase":"identify-stop"');
  expect(stdout()).toMatch(/gc=|"gc":/u);
});

it("preserves native trace-flag inheritance and explicit worker baseline preload propagation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "transcript-worker-preload-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const resultPath = path.join(directory, "result.json");
  const baselineOwner = new URL(
    "../../src/config/sessions/session-actor-replica.ts",
    import.meta.url,
  ).href;
  await writeFile(
    path.join(directory, "worker.mjs"),
    `import { parentPort } from "node:worker_threads";
     parentPort.postMessage({
       resolved: import.meta.resolve(${JSON.stringify(baselineOwner)}),
       inheritedTrace: process.execArgv.includes("--trace-gc-nvp"),
       baseline: process.env.OPENCLAW_BENCH_TRANSCRIPT_BASELINE_OWNERS,
       output: process.env.OPENCLAW_BENCH_WORKER_MEMORY_DIR,
       sentinel: process.env.BENCH_WORKER_SENTINEL,
     });`,
  );
  const entry = path.join(directory, "entry.mjs");
  await writeFile(
    entry,
    `import { Worker } from "node:worker_threads";
     import { once } from "node:events";
     import { writeFileSync } from "node:fs";
     const results = [];
     for (const options of [{}, { execArgv: [], env: { BENCH_WORKER_SENTINEL: "explicit" } }]) {
       const worker = new Worker(new URL("./worker.mjs", import.meta.url), options);
       const [[result], [code]] = await Promise.all([once(worker, "message"), once(worker, "exit")]);
       if (code !== 0) throw new Error("Worker exited with code " + code);
       results.push(result);
     }
     writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(results));`,
  );
  const { closed, stderr } = spawnFixture(
    [
      "--trace-gc-nvp",
      "--import",
      new URL("../../scripts/perf/transcript-worker-memory-preload.ts", import.meta.url).href,
      entry,
    ],
    undefined,
    false,
    {
      ...process.env,
      OPENCLAW_BENCH_TRANSCRIPT_BASELINE_OWNERS: "1",
      OPENCLAW_BENCH_WORKER_MEMORY_DIR: directory,
      BENCH_WORKER_SENTINEL: "inherited",
    },
  );
  expect(await closed, stderr()).toEqual([0, null]);
  const common = {
    resolved: baselineOwner.replace(/\.ts$/u, ".baseline.ts"),
    baseline: "1",
    output: directory,
  };
  expect(await readJson(resultPath)).toEqual([
    { ...common, inheritedTrace: true, sentinel: "inherited" },
    { ...common, inheritedTrace: false, sentinel: "explicit" },
  ]);
});

it("attributes worker receipts without retaining labels or treating unsized messages as empty", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-message-attribution-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const profilePath = path.join(directory, "heap");
  const workerPath = path.join(directory, "session-transcript.worker.mjs");
  await writeFile(
    workerPath,
    `import { parentPort } from "node:worker_threads";
     parentPort.on("message", ({ taskId, input }) => {
       parentPort.postMessage({ status: "ok", taskId, value: input.value });
     });`,
  );
  const { child, stderr } = spawnFixture([
    "--import",
    new URL("../../scripts/tsx.mjs", import.meta.url).href,
    "--input-type=module",
    "-e",
    `
    process.env.OPENCLAW_BENCH_WORKER_ATTRIBUTION = "1";
    process.argv[1] = ${JSON.stringify(fileURLToPath(new URL("../../src/entry.ts", import.meta.url)))};
    await import(${JSON.stringify(preloadUrl)});
    const { observeWorkerMessage, recordWorkerMessage } = await import(${JSON.stringify(new URL("../../src/infra/worker-message-metrics.ts", import.meta.url).href)});
    const { createSqliteWorkerOperationAdmission } = await import(${JSON.stringify(new URL("../../src/infra/sqlite-worker-operation-admission.ts", import.meta.url).href)});
    const { WorkerTaskPool } = await import(${JSON.stringify(new URL("../../src/infra/worker-task-pool.ts", import.meta.url).href)});
    const { MessageChannel, Worker } = await import("node:worker_threads");
    const { once } = await import("node:events");
    const { pathToFileURL } = await import("node:url");
    const v8 = await import("node:v8");
    process.channel.ref();
    process.on("message", message => {
      if (!message.run) return;
      if (message.run === "tasks") {
        void (async () => {
          const pool = new WorkerTaskPool({
            workerUrl: pathToFileURL(${JSON.stringify(workerPath)}),
            workerOptions: { execArgv: [] },
            maxWorkers: 1,
          });
          let getterCalls = 0;
          let completed;
          const external = new Worker('const { parentPort } = require("node:worker_threads"); parentPort.on("message", value => parentPort.postMessage(value));', { eval: true, execArgv: [] });
          try {
            const values = [];
            for (const kind of ["session-row-facts", "history-page", "fixture-private-task"]) {
              values.push(await pool.run({ kind, value: "x".repeat(2048) }, {}));
            }
            const response = once(external, "message");
            external.postMessage({ get text() { getterCalls++; return "y".repeat(1024); } });
            const [echoed] = await response;
            completed = { complete: true, getterCalls, replyBytes: values.reduce((sum, value) => sum + value.length, 0), echoedBytes: echoed.text.length };
          } finally {
            await pool.close();
            await external.terminate();
          }
          process.send(completed);
        })().catch(error => process.send({ error: String(error) }));
        return;
      }
      const privateKind = "fixture-private-identifier";
      observeWorkerMessage({ status: "notification", value: { kind: privateKind, text: "x".repeat(4096) } }, "from_worker");
      const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
      admission.port.postMessage({ stage: "transaction", decision: new SharedArrayBuffer(4), facts: { publication: { kind: "session-actor-admission", snapshot: { entry: { skillsSnapshot: "s".repeat(1024) } } } } });
      admission.port.postMessage({ kind: "native-commit", payloadBytes: 40, committed: { version: 1, sequence: 1, facts: { kind: "committed", receipt: { kind: "session-actor-committed", phase: "appendTranscriptEvent", postimage: { entry: { systemPromptReport: "p".repeat(2048) } } } } } });
      admission.service();
      admission.finish();
      const { port1, port2 } = new MessageChannel();
      observeWorkerMessage({ status: "notification", port: port1 }, "from_worker");
      port1.close(); port2.close();
      recordWorkerMessage("lifecycle", "from_worker");
      v8.deserialize(v8.serialize({ kind: privateKind, value: 42 }));
      process.send({ complete: true });
    });
    process.send({ ready: true });
  `,
  ]);
  await waitMessage(child, "ready");
  await controlGatewayProfile(child, "heap", "start", profilePath);
  expect(await sendMessage(child, { run: true }), stderr()).toEqual({ complete: true });
  await controlGatewayProfile(child, "heap", "stop", profilePath);
  const result = await readJson<ReturnType<ReturnType<typeof startGatewayBenchWorkerMessages>>>(
    `${profilePath}.worker-attribution.json`,
  );
  expect(result.overflowMessages).toBe(0);
  expect(result.groups.reduce((sum, group) => sum + group.messages, 0)).toBe(5);
  expect(result.groups).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "task_notification",
        messages: 2,
        serializedMessages: 1,
        serializedBytes: expect.any(Number),
        failedSerializationMessages: 1,
      }),
      expect.objectContaining({
        kind: "authority",
        operation: "transaction",
        facts: "session-actor-admission",
        sharedBufferMessages: 1,
        sharedBackingBytes: 4,
        serializedMessages: 1,
      }),
      expect.objectContaining({
        kind: "authority",
        operation: "native-commit",
        receipt: "session-actor-committed",
        knownPayloadBytes: 40,
        serializedMessages: 1,
      }),
      expect.objectContaining({
        kind: "lifecycle",
        unavailableMessageValues: 1,
        serializedMessages: 0,
      }),
    ]),
  );
  expect(
    result.groups.find((group) => group.kind === "task_notification")?.serializedBytes,
  ).toBeGreaterThan(4096);
  const authority = result.groups.find((group) => group.operation === "transaction");
  expect(authority?.sections["authorityEntry.skillsSnapshot"]?.serializedBytes).toBeGreaterThan(
    1024,
  );
  const receipt = result.groups.find((group) => group.operation === "native-commit");
  expect(receipt?.phase).toBe("appendTranscriptEvent");
  expect(receipt?.sections["postimageEntry.systemPromptReport"]?.serializedBytes).toBeGreaterThan(
    2048,
  );
  expect(JSON.stringify(result)).not.toContain("fixture-private-identifier");
  const deserialized = await readJson<{ groups: Record<string, { count: number; bytes: number }> }>(
    `${profilePath}.deserialize.json`,
  );
  expect(deserialized.groups.other).toMatchObject({ count: 1 });
  expect(deserialized.groups).not.toHaveProperty("fixture-private-identifier");
  const taskProfilePath = path.join(directory, "tasks");
  await controlGatewayProfile(child, "heap", "start", taskProfilePath);
  expect(await sendMessage(child, { run: "tasks" }), stderr()).toEqual({
    complete: true,
    getterCalls: 1,
    replyBytes: 6144,
    echoedBytes: 1024,
  });
  await controlGatewayProfile(child, "heap", "stop", taskProfilePath);
  const tasks = await readJson<
    ReturnType<ReturnType<typeof startGatewayBenchWorkerMessages>> & { sourceHooks: string[] }
  >(`${taskProfilePath}.worker-attribution.json`);
  expect(tasks.sourceHooks).toEqual([
    "sqlite-worker-operation-admission.ts",
    "worker-cpu.ts",
    "worker-message-metrics.ts",
    "worker-task-pool-core.ts",
  ]);
  expect(tasks.overflowTaskReplies).toBe(0);
  expect(tasks.taskReplies).toHaveLength(3);
  expect(tasks.taskReplies.map((group) => group.operation).toSorted()).toEqual([
    "history-page",
    "session-row-facts",
    "task",
  ]);
  for (const group of tasks.taskReplies) {
    expect(group).toMatchObject({
      script: "session-transcript.worker.js",
      outcome: "ok",
      messages: 1,
      serializedMessages: 1,
      failedSerializationMessages: 0,
    });
    expect(group.serializedBytes).toBeGreaterThan(2048);
  }
  const transport = tasks.groups.find(
    (group) => group.kind === "task_reply" && group.direction === "from_worker",
  );
  expect(transport).toMatchObject({ messages: 3, script: "session-transcript.worker.js" });
  expect(transport?.serializedBytes).toBe(
    tasks.taskReplies.reduce((sum, group) => sum + group.serializedBytes, 0),
  );
  expect(tasks.groups).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "other",
        direction: "from_worker",
        script: "other",
        messages: 1,
        serializedMessages: 1,
        unavailableMessageValues: 0,
        serializedBytes: expect.any(Number),
      }),
      expect.objectContaining({
        kind: "other",
        direction: "to_worker",
        messages: 1,
        unavailableMessageValues: 1,
      }),
    ]),
  );
  expect(JSON.stringify(tasks)).not.toContain("fixture-private-task");
});

it.each([
  ["broadcastInternal", "gateway-prewarm.js"],
  ["", new URL("../../src/gateway/server-broadcast.ts", import.meta.url).href],
])("attributes deep broadcast stacks under %s (%s)", async (name, url) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-broadcast-profile-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const frame = (
    functionName: string,
    file: string,
    selfSize: number,
    children: HeapProfiler.SamplingHeapProfileNode[] = [],
  ): HeapProfiler.SamplingHeapProfileNode => ({
    callFrame: { functionName, scriptId: "1", url: file, lineNumber: 0, columnNumber: 0 },
    selfSize,
    children,
  });
  let projection = frame("", "session-event-projection.ts", 20, [
    frame("prepareSessionRowRecipient", "session-row-presentation.ts", 30, [
      frame("prepareSessionSharing", "session-sharing-read.ts", 40),
    ]),
    frame("present", "session-row-presentation.ts", 50),
    frame("serializeSession", "session-event-projection.ts", 60, [frame("", "", 70)]),
  ]);
  for (let depth = 0; depth < 9; depth++) {
    projection = frame("wrapper", "", 0, [projection]);
  }
  const profile: HeapProfiler.SamplingHeapProfile = {
    head: frame("root", "", 0, [frame("unrelated", "", 1000), frame(name, url, 100, [projection])]),
  };
  const file = path.join(directory, "allocation.heapprofile");
  await writeFile(file, JSON.stringify(profile));
  const result = readGatewayHeapProfile(file);
  expect(result.sampledAllocatedBytes).toBe(1370);
  expect(result.broadcastAllocation).toMatchObject({
    sourceProjectionObserved: true,
    sampledBytes: 370,
    projectionSelfSampledBytes: 80,
    families: {
      otherBroadcast: { sampledBytes: 100 },
      eventProjection: { sampledBytes: 20 },
      recipientSetup: { sampledBytes: 70 },
      rowPresentation: { sampledBytes: 50 },
      encoding: { sampledBytes: 130 },
    },
  });
});

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
  const stopDiagnostics = await startGatewayDiagnostics(child);
  await expect(startGatewayDiagnostics(child)).rejects.toThrow("already started");
  const stopBurstDiagnostics = await startGatewayDiagnostics(child, "burst");
  await expect(startGatewayDiagnostics(child, "burst")).rejects.toThrow("already started");
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
  const burstDiagnostics = await stopBurstDiagnostics();
  await expect(stopBurstDiagnostics()).rejects.toThrow("have not started");

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
  const diagnostics = await stopDiagnostics();
  expect(burstDiagnostics.startedAtEpochMs).toBeGreaterThan(diagnostics.startedAtEpochMs);
  expect(burstDiagnostics.endedAtEpochMs).toBeLessThan(diagnostics.endedAtEpochMs);
  expect(diagnostics.eventLoopDelay.count).toBeGreaterThan(0);
  expect(diagnostics.eventLoopDelay.maxMs).toBeGreaterThan(0);
  expect(diagnostics.endedAtEpochMs).toBeGreaterThan(diagnostics.startedAtEpochMs);
  await expect(stopDiagnostics()).rejects.toThrow("have not started");
  const stopAgain = await startGatewayDiagnostics(child);
  expect((await stopAgain()).collectionErrors).toBe(0);
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
      const { Session } = require('node:inspector/promises');
      let total = 0;
      let retainedRows;
      function allocateForProfile() {
        const until = Date.now() + 500;
        while (Date.now() < until) {
          const rows = Array.from({length: 10000}, (_, i) => ({i, values: [i, i + 1]}));
          total += rows[rows.length - 1].values[1];
        }
        parentPort.postMessage(total);
      }
      function retainedWorkerAllocation() {
        return Array.from({length: 100000}, (_, i) => ({i, values: [i, i + 1]}));
      }
      function discardedWorkerAllocation() {
        // Avoid hot callback bookkeeping that V8 can retain after collecting the rows.
        const rows = new Array(1_000_000).fill(1);
        return rows[rows.length - 1];
      }
      parentPort.on('message', async message => {
        if (message !== 'fixed-allocations') return allocateForProfile();
        total += discardedWorkerAllocation();
        retainedRows = retainedWorkerAllocation();
        const inspector = new Session();
        inspector.connect();
        await inspector.post('HeapProfiler.collectGarbage');
        inspector.disconnect();
        parentPort.postMessage({retained: retainedRows.length, total});
      });
    \`, {eval: true, execArgv: [], name: "profile-workload"});
    worker.on('message', result => process.send({complete: true, threadId: worker.threadId, result}));
}
process.on('message', (message) => {
  if (message.prepare) {
    idle = new Worker('setInterval(() => {}, 1000)', {eval: true, execArgv: [], name: "profile-workload"});
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
  if (message.fixedAllocations) worker.postMessage('fixed-allocations');
  if (message.retire) Promise.all([worker, idle].filter(Boolean).map(w => w.terminate()))
    .then(() => process.send({retired: true}));
});
(async () => {
  // A retired worker consumes a native ID before the inspector allocates any target IDs.
  const retired = new Worker('', {eval: true, execArgv: [], name: "profile-workload"});
  await once(retired, 'exit');
  await import(process.argv[1]);
  process.send({ready: true});
})();
`;

it.each(["read-only", "accessor"])(
  "preserves %s worker termination and reports its missing retirement profile",
  async (method) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-worker-readonly-"));
    const profilePath = path.join(directory, "heap");
    const { child } = spawnFixture(
      [
        "--import",
        new URL("../../scripts/tsx.mjs", import.meta.url).href,
        "-e",
        `
        const { Worker } = require('node:worker_threads');
        const { once } = require('node:events');
        const keepAlive = setInterval(() => {}, 1000);
        process.once('disconnect', () => clearInterval(keepAlive));
        let terminateReads = 0;
        class ForeignWorker extends Worker {
          #terminate = Worker.prototype.terminate;
          get terminate() { terminateReads++; return this.#terminate; }
        }
        if ('${method}' === 'read-only') {
          Object.defineProperty(ForeignWorker.prototype, 'terminate', {
            value: Worker.prototype.terminate, writable: false,
          });
        }
        (async () => {
          await import(process.argv[1]);
          const worker = new ForeignWorker('setInterval(() => {}, 1000)', {
            eval: true, execArgv: [], name: 'readonly-termination',
          });
          await once(worker, 'online');
          process.on('message', async message => {
            if (message.retire) {
              await worker.terminate();
              process.send({ retired: true });
            }
          });
          process.send({ ready: true, terminateReads });
        })();
      `,
        preloadUrl,
      ],
      directory,
    );
    expect(await waitMessage(child, "ready")).toMatchObject({ terminateReads: 0 });
    await controlGatewayProfile(child, "heap", "start", profilePath, { includeWorkers: true });
    expect(await sendMessage(child, { retire: true })).toEqual({ retired: true });
    await controlGatewayProfile(child, "heap", "stop", profilePath);
    const manifest = await readJson<WorkerProfileManifest>(`${profilePath}.workers.json`);
    const recording = manifest.workers.find(({ title }) => title.includes("readonly-termination"));
    expect(recording?.completed).not.toBe(true);
    expect(recording?.error).toMatch(/Worker retired/);
  },
  30_000,
);

async function waitMessage(child: ChildProcess, field: string) {
  for await (const [message] of on(child, "message", { close: ["exit"] })) {
    if (message[field]) {
      return message;
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
    const { child } = spawnFixture(
      [
        "--import",
        new URL("../../scripts/tsx.mjs", import.meta.url).href,
        "-e",
        workload,
        preloadUrl,
      ],
      directory,
    );
    await waitMessage(child, "ready");
    if (preexisting) {
      expect(await sendMessage(child, { prepare: true })).toMatchObject({ prepared: true });
    }
    await controlGatewayProfile(child, kind, "start", profilePath, { includeWorkers: true });
    const completed = await sendMessage(child, { run: true });
    expect(completed.complete).toBe(true);
    await controlGatewayProfile(child, kind, "stop", profilePath, { includeWorkers: true });
    const manifest = await readJson<WorkerProfileManifest>(`${profilePath}.workers.json`);
    // Direct workers created before the registry remain explicitly unregistered.
    const preexistingWorkers = manifest.workers.filter((worker) => !worker.script);
    expect(preexistingWorkers.length).toBeGreaterThan(0);
    expect(preexistingWorkers.every((worker) => worker.unregisteredWhileLive)).toBe(true);
    manifest.workers = manifest.workers.filter((worker) =>
      worker.title.includes("profile-workload"),
    );
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
        samplingStartedAt: expect.any(Number),
        samplingStoppedAt: expect.any(Number),
      });
      expect(recording.error).toBeUndefined();
      expect(recording.script).toBe(preexisting ? undefined : "other");
      if (preexisting) {
        expect(recording.unregisteredWhileLive).toBe(true);
      } else {
        expect(recording.unregisteredWhileLive).not.toBe(true);
      }
      expect(recording.title).toContain(`[worker ${recording.threadId}]`);
      expect(recording.samplingStartedAt).toBeGreaterThanOrEqual(recording.startedAt);
      expect(recording.samplingStoppedAt).toBeGreaterThan(recording.samplingStartedAt!);
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

    if (kind === "heap") {
      // Exercise retention before another capture can warm the allocation fixture.
      for (const includeCollectedObjects of [false, true]) {
        const fixedPath = path.join(directory, `heap-collected-${includeCollectedObjects}`);
        const samplingIntervalBytes = 1024;
        await controlGatewayProfile(child, "heap", "start", fixedPath, {
          includeWorkers: true,
          includeCollectedObjects,
          samplingIntervalBytes,
        });
        expect(await sendMessage(child, { fixedAllocations: true })).toMatchObject({
          complete: true,
          result: { retained: 100000 },
        });
        await controlGatewayProfile(child, "heap", "stop", fixedPath);
        const fixedManifest = await readJson<WorkerProfileManifest>(`${fixedPath}.workers.json`);
        expect(fixedManifest).toMatchObject({ includeCollectedObjects, samplingIntervalBytes });
        const recording = fixedManifest.workers.find(
          ({ threadId }) => threadId === completed.threadId,
        );
        expect(recording).toMatchObject({ completed: true });
        // V8 exports allocation samples beyond Node's inspector profile declaration.
        const profile = await readJson<HeapProfiler.SamplingHeapProfile & { samples: unknown[] }>(
          recording!.profilePath,
        );
        expect(heapBytesUnder(profile.head, "retainedWorkerAllocation")).toBeGreaterThan(1_000_000);
        const discardedBytes = heapBytesUnder(profile.head, "discardedWorkerAllocation");
        if (includeCollectedObjects) {
          expect(discardedBytes).toBeGreaterThan(1_000_000);
        } else {
          expect(discardedBytes).toBe(0);
        }
        // The fixed retained workload yields thousands of 1 KiB samples, versus hundreds at 32 KiB.
        expect(profile.samples.length).toBeGreaterThan(2000);
      }
    }

    const retiredPath = path.join(directory, `${kind}-retired`);
    await controlGatewayProfile(child, kind, "start", retiredPath, { includeWorkers: true });
    expect(await sendMessage(child, { run: true })).toMatchObject({ complete: true });
    expect(await sendMessage(child, { retire: true })).toMatchObject({ retired: true });
    await controlGatewayProfile(child, kind, "stop", retiredPath, { includeWorkers: true });
    const retired = await readJson<WorkerProfileManifest>(`${retiredPath}.workers.json`);
    retired.workers = retired.workers.filter((worker) => worker.title.includes("profile-workload"));
    expect(workerIdentities(retired)).toEqual(workerIdentities(manifest));
    for (const recording of retired.workers) {
      expect(recording.completed).toBe(true);
      expect(recording.error).toBeUndefined();
      expect(recording.script).toBe(preexisting ? undefined : "other");
      if (preexisting) {
        expect(recording.unregisteredWhileLive).toBe(true);
      } else {
        expect(recording.unregisteredWhileLive).not.toBe(true);
      }
      expect(recording.samplingStoppedAt).toBeGreaterThan(recording.samplingStartedAt!);
      if (recording.threadId === completed.threadId) {
        if (kind === "cpu") {
          const profile = await readJson<Profiler.Profile>(recording.profilePath);
          expect(profile.samples?.length ?? 0).toBeGreaterThan(50);
        } else {
          expect(
            readGatewayHeapProfile(recording.profilePath).sampledAllocatedBytes,
          ).toBeGreaterThan(1_000_000);
        }
      }
    }
  },
  30_000,
);

it("separates discarded allocation churn from retained objects and cleans up failed captures", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-allocation-"));
  const { child, closed, stdout } = spawnFixture(
    [
      "--expose-gc",
      "--trace-gc-nvp",
      "--input-type=module",
      "-e",
      `
    await import(${JSON.stringify(preloadUrl)});
    process.channel.ref();
    let retainedRows;
    function retainedAllocation() {
      return Array.from({ length: 100000 }, (_, i) => ({ i, values: [i, i + 1] }));
    }
    // Keep GC/promotion churn separate from the exact-zero discarded allocation fixture.
    function allocationChurn() {
      let checksum = 0;
      for (let batch = 0; batch < 10; batch++) {
        const rows = Array.from({ length: 20000 }, (_, i) => ({ i, values: [i, i + 1] }));
        checksum += rows[rows.length - 1].values[1];
      }
      return checksum;
    }
    function discardedAllocation() {
      const rows = new Array(1_000_000).fill(1);
      return rows[rows.length - 1];
    }
    process.on('message', async message => {
      if (message.stop) return process.disconnect();
      if (!message.run) return;
      for (let operation = 0; operation < 4; operation++) {
        allocationChurn();
        discardedAllocation();
      }
      if (message.retain) retainedRows = retainedAllocation();
      globalThis.gc();
      await new Promise(setImmediate);
      await new Promise(setImmediate);
      process.send({ completed: 4, ...(message.retain ? { retained: retainedRows.length } : {}) });
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
  const stopDiagnostics = await startGatewayDiagnostics(child, "soak");
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
  const diagnostics = await stopDiagnostics();
  expect(diagnostics.gc.durationMs?.total).toBeGreaterThan(0);
  expect(diagnostics.gc.majorDurationMs?.count).toBeGreaterThan(0);
  expect(diagnostics.gc.minorDurationMs?.count).toBeGreaterThan(0);
  expect(diagnostics.gc.unknownDurationMs).toBeUndefined();
  expect(
    ["major", "minor", "incremental", "weakCallback"].reduce(
      (total, kind) => total + (diagnostics.gc[`${kind}DurationMs`]?.count ?? 0),
      0,
    ),
  ).toBe(diagnostics.gc.durationMs?.count);
  expect(diagnostics.collectionErrors).toBe(0);
  expect(
    result.topAllocationSites.some((site) =>
      site.stack.some((frame) => frame.startsWith("discardedAllocation (")),
    ),
  ).toBe(true);

  const retainedPath = path.join(directory, "retained");
  await controlGatewayProfile(child, "heap", "start", retainedPath, {
    includeCollectedObjects: false,
  });
  expect(await sendMessage(child, { run: true, retain: true })).toEqual({
    completed: 4,
    retained: 100000,
  });
  await readGatewayResources(child, { collectGarbage: true });
  await controlGatewayProfile(child, "heap", "stop", retainedPath);
  const retained = await readJson<HeapProfiler.SamplingHeapProfile>(retainedPath);
  expect(heapBytesUnder(retained.head, "retainedAllocation")).toBeGreaterThan(1_000_000);
  expect(heapBytesUnder(retained.head, "discardedAllocation")).toBe(0);
  // Child-side IPC shutdown lets Node observe EOF and emit the close event.
  child.send({ stop: true });
  await closed;
  const logPath = path.join(directory, "gateway.log");
  await writeFile(logPath, stdout());
  const gc = readGatewayGcTrace(logPath, path.join(directory, "completed"));
  expect(gc).toMatchObject({ scope: "main-isolate", source: "v8-trace-gc-nvp", pid: child.pid });
  expect(gc.promotedBytes).toBeGreaterThan(0);
  expect(gc.gcCount).toBeGreaterThan(0);
  expect(readGatewayGcTrace(logPath, retainedPath).promotedBytes).toBeGreaterThan(0);
  expect(readGatewayGcTrace(logPath, "soak", "diagnostics").promotedBytes).toBeGreaterThan(0);
});

it("accounts only the identified main isolate inside the requested heap capture", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-gc-trace-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const logPath = path.join(directory, "gateway.log");
  const trace = [
    'OPENCLAW_GATEWAY_BENCH_GC {"phase":"identify-start","pid":42}',
    '[42:0xabc:0] 5 ms: GC: {"gc":"mc","promoted":8192}',
    'OPENCLAW_GATEWAY_BENCH_GC {"phase":"identify-stop","pid":42}',
    "[42:0xabc] 10 ms: pause=1.0 gc=s promoted=4096",
    'OPENCLAW_GATEWAY_BENCH_GC {"phase":"heap-start","pid":42,"profilePath":"measured"}',
    'OPENCLAW_GATEWAY_BENCH_GC {"phase":"diagnostics-start","pid":42,"profilePath":"soak"}',
    "[42:0xabc] 15 ms: pause=1.0 gc=s promoted=1024",
    '[42:0xdef:1] 16 ms: GC: {"gc":"s","promoted":65536}',
    '[42:0xdef:1] 16 ms: GC: {"gc":"s",interleaved worker log',
    "[43:0xabc] 17 ms: pause=1.0 gc=s promoted=65536",
    'OPENCLAW_GATEWAY_BENCH_GC {"phase":"diagnostics-stop","pid":42,"profilePath":"soak"}',
    '[42:0xabc:0] 18 ms: GC: {"gc":"mc","promoted":256}',
    'OPENCLAW_GATEWAY_BENCH_GC {"phase":"heap-stop","pid":42,"profilePath":"measured"}',
    'OPENCLAW_GATEWAY_BENCH_GC {"phase":"diagnostics-start","pid":42,"profilePath":"round-1"}',
    "[42:0xabc] 19 ms: pause=2.0 gc=s promoted=2048",
    'OPENCLAW_GATEWAY_BENCH_GC {"phase":"diagnostics-stop","pid":42,"profilePath":"round-1"}',
    "[42:0xabc] 20 ms: pause=1.0 gc=s promoted=4096",
    '[42:0xabc:0] 25 ms: GC: {"gc":"s",interleaved shutdown log',
  ].join("\n");
  await writeFile(logPath, trace);
  expect(readGatewayGcTrace(logPath, "measured")).toMatchObject({
    pid: 42,
    isolate: "0xabc",
    promotedBytes: 1280,
    gcCount: 2,
    excludedWorkerGcCount: 2,
  });
  expect(readGatewayGcTrace(logPath, "soak", "diagnostics")).toMatchObject({
    promotedBytes: 1024,
    gcCount: 1,
    excludedWorkerGcCount: 2,
  });
  expect(readGatewayGcTrace(logPath, "round-1", "diagnostics")).toMatchObject({
    promotedBytes: 2048,
    gcCount: 1,
    excludedWorkerGcCount: 0,
  });
  expect(() => readGatewayGcTrace(logPath, "missing")).toThrow("complete heap capture window");
  for (const malformed of [
    trace.replace("promoted=1024", "promoted=NaN"),
    trace.replace("promoted=1024", "promoted=-1"),
    trace.replace("promoted=1024", "unavailable=1024"),
  ]) {
    await writeFile(logPath, malformed);
    expect(() => readGatewayGcTrace(logPath, "measured")).toThrow("promoted byte count");
  }
  await writeFile(logPath, trace.replace('"phase":"identify-stop"', '"phase":"missing"'));
  expect(() => readGatewayGcTrace(logPath, "measured")).toThrow("invalid heap capture start");
  await writeFile(
    logPath,
    trace.replace(
      '[42:0xabc:0] 5 ms: GC: {"gc":"mc","promoted":8192}',
      '[42:0xabc:0] 5 ms: GC: {"gc":"mc","promoted":8192}\n[42:0xdef] 6 ms: gc=s promoted=0',
    ),
  );
  expect(() => readGatewayGcTrace(logPath, "measured")).toThrow("exactly one main isolate");
});
