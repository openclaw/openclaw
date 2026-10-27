import { EventEmitter, once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getHeapStatistics } from "node:v8";
import { MessageChannel, MessagePort, Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { WorkerMemorySample } from "./diagnostic-process-types.js";
import {
  getTrackedWorkerCpuSources,
  getTrackedWorkerLifecycleSnapshot,
  createCpuTrackedWorker,
  markWorkerRetirement,
  trackNativeWorkerForCpu,
  sampleTrackedWorkerMemory,
  attributeWorkerToPool,
  receiveWorkerMemoryPort,
  flushWorkerDiagnostics,
  setTrackedWorkerGcObserver,
} from "./worker-cpu.js";
import {
  getWorkerMessageMetrics,
  type WorkerMessageKind,
  type WorkerMessageDirection,
} from "./worker-message-metrics.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

// These endpoints run on the Gateway main thread; Vitest itself runs in a worker.
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  isMainThread: true,
}));

const workers: Worker[] = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
  setTrackedWorkerGcObserver(undefined);
  vi.restoreAllMocks();
});

const idleSource = 'require("node:worker_threads").parentPort.on("message", () => {});';
const echoSource =
  'const { parentPort } = require("node:worker_threads"); parentPort.on("message", (value) => parentPort.postMessage(value));';
const retainedBytes = 4 * 1024 * 1024;
type NativeHeap = Awaited<ReturnType<Worker["getHeapStatistics"]>>;
type Lifecycle = ReturnType<typeof getTrackedWorkerLifecycleSnapshot>;

function registerWorker(threadId: number, script: string) {
  const worker = Object.assign(new EventEmitter(), {
    threadId,
    cpuUsage: async () => ({ user: 0, system: 0 }),
    getHeapStatistics: async () => getHeapStatistics(),
  });
  trackNativeWorkerForCpu(worker, new URL(script, import.meta.url));
  return worker;
}

async function sampledMemory() {
  sampleTrackedWorkerMemory();
  await Promise.resolve();
  return sampleTrackedWorkerMemory();
}

async function createWorker(filename: string | URL = idleSource) {
  const worker = createCpuTrackedWorker(filename, { eval: typeof filename === "string" });
  workers.push(worker);
  await once(worker, "online");
  return worker;
}

async function fileWorker(file: string, source = idleSource) {
  const filename = join(tempDirs.make("worker-cpu-"), file);
  await writeFile(filename, source);
  return createWorker(pathToFileURL(filename));
}

async function roundTrip(
  worker: Worker,
  value: unknown,
  transferList: readonly ArrayBuffer[] = [],
) {
  const reply = once(worker, "message");
  worker.postMessage(value, transferList);
  return reply;
}

function metricDelta(kind: WorkerMessageKind, direction: WorkerMessageDirection) {
  const before = getWorkerMessageMetrics().find(
    (row) => row.kind === kind && row.direction === direction,
  );
  return (payloadBytes = 0, unmeasuredMessages = 1) => ({
    kind,
    direction,
    messages: (before?.messages ?? 0) + 1,
    payloadBytes: (before?.payloadBytes ?? 0) + payloadBytes,
    unmeasuredMessages: (before?.unmeasuredMessages ?? 0) + unmeasuredMessages,
  });
}

const nativeHeap = (heap: NativeHeap) => ({
  heapUsed: heap.used_heap_size,
  heapTotal: heap.total_heap_size,
  external: heap.external_memory,
});
const retiredCount = (snapshot: Lifecycle, script: string, reason: string) =>
  snapshot.workerLifecycle
    .find((entry) => entry.script === script)
    ?.retired.find((entry) => entry.reason === reason)?.count ?? 0;

describe("worker CPU lifecycle", () => {
  it("reuses CPU source snapshots until native membership changes", () => {
    const initial = getTrackedWorkerCpuSources();
    const worker = registerWorker(9000, "./cpu-snapshot.worker.ts");
    try {
      const added = getTrackedWorkerCpuSources();
      expect(added.workers).toHaveLength(initial.workers.length + 1);
      for (let sample = 0; sample < 60; sample++) {
        expect(getTrackedWorkerCpuSources()).toBe(added);
      }
      // Cleanup can remove exit listeners; pruning still invalidates the snapshot.
      worker.removeAllListeners("exit");
      worker.threadId = -1;
      expect(added.currentRevision()).toBeGreaterThan(added.revision);
      const removed = getTrackedWorkerCpuSources();
      expect(removed.workers).toEqual(initial.workers);
      expect(getTrackedWorkerCpuSources()).toBe(removed);
      expect(added.workers).toHaveLength(initial.workers.length + 1);
    } finally {
      worker.threadId = -1;
      getTrackedWorkerCpuSources();
    }
  });

  it("retains task heap and GC totals across worker retirement without retaining worker ids", async () => {
    const register = (id: number) => {
      const worker = registerWorker(id, "./provider-prompt-state.worker.ts");
      attributeWorkerToPool(worker, {}, "compute");
      return worker;
    };
    const first = register(9001);
    const reply = async (
      worker: typeof first,
      heapUsed: number,
      durationMs: number,
      reclaimedBytes: number,
    ) => {
      expect(receiveWorkerMemoryPort(worker, { status: "ok", diagnostics: true })).toBe(false);
      const { port1, port2 } = new MessageChannel();
      receiveWorkerMemoryPort(worker, { status: "memory", port: port1 });
      const sample = once(port1, "message");
      port2.postMessage({ heapUsed, heapTotal: 4096, external: 0, arrayBuffers: 0 });
      await sample;
      const flush = flushWorkerDiagnostics(worker, "rotation")!;
      expect(flushWorkerDiagnostics(worker, "rotation")).toBe(flush);
      expect(flush.read().status).toBe("pending");
      port2.postMessage({
        gc: [{ kind: "scavenge", reason: "other", durationMs, reclaimedBytes }],
      });
      port2.postMessage({
        heapUsed: heapUsed / 2,
        flushed: true,
      });
      // The retained cleanup path must make progress without running port callbacks.
      flush.service();
      expect(flush.read().status).toBe("fulfilled");
      await flush.result;
      port1.close();
      port2.close();
    };
    const snapshot = () =>
      sampleTrackedWorkerMemory().workerTaskMetrics.find(
        (entry) =>
          entry.workerClass === "compute" && entry.script === "provider-prompt-state.worker.js",
      );
    setTrackedWorkerGcObserver(() => {});
    await reply(first, 2048, 2, 512);
    first.emit("exit");
    const second = register(9002);
    await reply(second, 768, 3, 256);
    second.emit("exit");
    expect(snapshot()).toEqual({
      workerClass: "compute",
      script: "provider-prompt-state.worker.js",
      tasksCompleted: 2,
      heapUsedHighWaterBytes: 2048,
      gc: [{ kind: "scavenge", count: 2, durationMs: 5, reclaimedBytes: 768 }],
    });
  });

  it("bounds an unanswered retirement sample while synchronous cleanup owns the thread", async () => {
    const worker = await createWorker();
    attributeWorkerToPool(worker, {}, "compute");
    const { port1, port2 } = new MessageChannel();
    receiveWorkerMemoryPort(worker, { status: "memory", port: port1 });
    setTrackedWorkerGcObserver(() => {});
    try {
      expect(flushWorkerDiagnostics(worker, "cancelled")).toBeUndefined();
      const flush = flushWorkerDiagnostics(worker, "closed")!;
      flush.service();
      expect(flush.read().status).toBe("pending");
      vi.spyOn(performance, "now").mockReturnValue(performance.now() + 101);
      flush.service();
      expect(flush.read().status).toBe("fulfilled");
      await flush.result;
    } finally {
      port1.close();
      port2.close();
    }
  });

  it.each([
    ["ERR_WORKER_OUT_OF_MEMORY", "crash"],
    ["ERR_CODE_MODE_GC_THRASH", "gc-thrash"],
  ] as const)("attributes Code Mode %s before pool cleanup", async (code, reason) => {
    const before = getTrackedWorkerLifecycleSnapshot();
    const script = "code-mode-node.worker.js";
    const worker = await fileWorker(script);
    worker.on("error", () => markWorkerRetirement(worker, "closed"));
    worker.emit("error", Object.assign(new Error("synthetic native failure"), { code }));
    await worker.terminate();
    const count = (snapshot: Lifecycle) => retiredCount(snapshot, script, reason);
    expect(count(getTrackedWorkerLifecycleSnapshot()) - count(before)).toBe(1);
  });

  it("keeps Code Mode slots until native exit and bounds them across worker churn", async () => {
    const handles: ReturnType<typeof registerWorker>[] = [];
    const register = () => {
      const worker = registerWorker(handles.length + 1000, "../agents/code-mode-node.worker.ts");
      handles.push(worker);
      return worker;
    };
    try {
      for (let index = 0; index < 65; index++) {
        register();
      }
      const initial = (await sampledMemory()).workerHeaps;
      expect(initial.map((worker) => worker.workerSlot)).toEqual([
        ...Array.from({ length: 64 }, (_, index) => index + 1),
        undefined,
      ]);
      markWorkerRetirement(handles[0]!, "idle_timeout");
      const retiring = register();
      expect(
        (await sampledMemory()).workerHeaps.find((worker) => worker.threadId === retiring.threadId)
          ?.workerSlot,
      ).toBeUndefined();
      handles[0]!.emit("exit");
      const replacement = register();
      const live = (await sampledMemory()).workerHeaps;
      expect(live.find((worker) => worker.threadId === replacement.threadId)?.workerSlot).toBe(1);
      expect(live.find((worker) => worker.threadId === handles[1]!.threadId)?.workerSlot).toBe(2);
    } finally {
      for (const worker of handles) {
        worker.emit("exit");
      }
    }
  });

  it.each([
    {
      script: "openclaw-state-lease-heartbeat.worker.js",
      request: { id: 1, operation: "verify" },
      response: { id: 1, ok: true, expiresAt: 123 },
    },
    { script: "gateway-state-owner-heartbeat.worker.js", request: "stop", response: null },
  ])(
    "attributes $script by its heartbeat transport identity",
    async ({ script, request, response }) => {
      const worker = await fileWorker(
        script,
        `const { parentPort } = require("node:worker_threads"); parentPort.on("message", () => parentPort.postMessage(${JSON.stringify(response)}));`,
      );
      const before = getWorkerMessageMetrics();
      const requests = metricDelta("lifecycle", "to_worker");
      const replies = metricDelta("lifecycle", "from_worker");
      expect(await roundTrip(worker, request)).toEqual([response]);
      const after = getWorkerMessageMetrics();
      for (const expected of [requests(), replies()]) {
        expect(after).toContainEqual(
          expect.objectContaining({
            kind: expected.kind,
            direction: expected.direction,
            messages: expected.messages,
          }),
        );
      }
      expect(after.filter((row) => row.kind === "sqlite_reply")).toEqual(
        before.filter((row) => row.kind === "sqlite_reply"),
      );
    },
  );

  it("attributes dedicated reclamation requests and replies once at the native boundary", async () => {
    const request = metricDelta("sqlite_request", "to_worker");
    const response = metricDelta("sqlite_reply", "from_worker");
    const worker = await createWorker(
      'const { parentPort } = require("node:worker_threads"); parentPort.on("message", ({ operationId }) => parentPort.postMessage({ type: "reclaimed", operationId, settled: true, result: {} }));',
    );
    expect(
      await roundTrip(worker, { type: "reclaim", operationId: 1, plan: {}, coordination: {} }),
    ).toEqual([{ type: "reclaimed", operationId: 1, settled: true, result: {} }]);
    expect(getWorkerMessageMetrics()).toEqual(expect.arrayContaining([request(), response()]));
  });

  it.each([
    ["postMessage", "accessor"],
    ["emit", "readonly"],
  ] as const)("preserves a subclass with %s defined as %s", async (method, descriptorKind) => {
    class ReadOnlyWorker extends Worker {}
    const original = Worker.prototype[method];
    const getter = vi.fn(() => original);
    Object.defineProperty(
      ReadOnlyWorker.prototype,
      method,
      descriptorKind === "accessor" ? { get: getter } : { value: original, writable: false },
    );
    const worker = new ReadOnlyWorker(echoSource, { eval: true });
    workers.push(worker);
    if (method === "postMessage") {
      expect(getter).not.toHaveBeenCalled();
    }
    await once(worker, "online");
    expect(await roundTrip(worker, "round trip")).toEqual(["round trip"]);
  });

  it.each(["dependency", "factory"])(
    "counts %s Workers without inspecting their payload accessors",
    async (mode) => {
      const expected = metricDelta("other", "to_worker");
      const worker =
        mode === "dependency"
          ? new Worker(echoSource, { eval: true })
          : createCpuTrackedWorker(echoSource, { eval: true });
      workers.push(worker);
      await once(worker, "online");
      const input = vi.fn(() => "payload");
      const reply = roundTrip(worker, {
        get input() {
          return input();
        },
      });
      expect(await reply).toEqual([{ input: "payload" }]);
      expect(input).toHaveBeenCalledTimes(1);
      expect(getWorkerMessageMetrics()).toContainEqual(expected());
    },
  );

  it("counts native messages once and measures transferred bytes before detachment", async () => {
    const sent = metricDelta("sqlite_request", "to_worker");
    const receivedMetric = metricDelta("sqlite_request", "from_worker");
    const worker = await createWorker(echoSource);
    const input = new Uint8Array([1, 2, 3]);
    const received = roundTrip(worker, { type: "execute", actor: 1, id: 1, input }, [input.buffer]);
    expect(input.byteLength).toBe(0);
    expect(await received).toEqual([
      { type: "execute", actor: 1, id: 1, input: new Uint8Array([1, 2, 3]) },
    ]);
    expect(() => worker.postMessage({ type: "execute", actor: 1, input() {} }, [])).toThrow();
    expect(getWorkerMessageMetrics()).toEqual(
      expect.arrayContaining([sent(3, 0), receivedMetric(3, 0)]),
    );
  });

  it.each([
    ["sqlite-store.worker.ts", "sqlite-store.worker.js"],
    ["memory-worker-entry.ts", "workspace-memory.worker.js"],
    ["skills-worker-entry.ts", "workspace-skills.worker.js"],
    ["file-tool-read.worker.mjs", "read-file.worker.js"],
    ["private-session-worker.js", "other"],
  ])(
    "attributes %s and removes direct and owned Worker samples at native exit",
    async (file, script) => {
      const initial = sampleTrackedWorkerMemory();
      const direct = new Worker(idleSource, { eval: true });
      workers.push(direct);
      await once(direct, "online");
      const owned = await fileWorker(
        file,
        'import("node:worker_threads").then(({ parentPort }) => parentPort.on("message", () => {}));',
      );
      const [directHeap, ownedHeap] = await Promise.all([
        direct.getHeapStatistics(),
        owned.getHeapStatistics(),
      ]);
      const directHeapRead = vi.spyOn(direct, "getHeapStatistics").mockResolvedValue(directHeap);
      const ownedHeapRead = vi.spyOn(owned, "getHeapStatistics").mockResolvedValue(ownedHeap);
      expect(getTrackedWorkerLifecycleSnapshot().workerCount).toBe(initial.workerCount + 2);
      expect(directHeapRead).not.toHaveBeenCalled();
      expect(ownedHeapRead).not.toHaveBeenCalled();
      expect(sampleTrackedWorkerMemory()).toMatchObject({
        workerHeapUsedBytes: undefined,
        workerExternalBytes: undefined,
        workerMemoryCoverage: "unavailable",
      });
      await Promise.resolve();
      const memory = sampleTrackedWorkerMemory();
      for (const name of new Set(["other", script])) {
        expect(memory.workerLifecycle.find((entry) => entry.script === name)?.started).toBe(
          (initial.workerLifecycle.find((entry) => entry.script === name)?.started ?? 0) +
            (script === "other" ? 2 : 1),
        );
      }
      expect(memory).toMatchObject({
        workerCount: initial.workerCount + 2,
        workerHeapSampledCount: initial.workerHeapSampledCount + 2,
        workerArrayBuffersBytes: undefined,
        workerMemoryCoverage: "partial",
      });
      expect(memory.workerHeapTotalBytes).toBeGreaterThan(memory.workerHeapUsedBytes!);
      expect(memory.workerExternalBytes).toBeGreaterThan(0);
      expect(memory.workerHeaps).toEqual([
        ...initial.workerHeaps,
        expect.objectContaining({ script: "other", ...nativeHeap(directHeap) }),
        expect.objectContaining({ script, ...nativeHeap(ownedHeap) }),
      ]);
      markWorkerRetirement(owned, "idle_timeout");
      markWorkerRetirement(owned, "failure");
      expect(sampleTrackedWorkerMemory().workerLifecycle).toEqual(memory.workerLifecycle);
      // Some consumers clear listeners before native teardown; counters must still retire.
      direct.removeAllListeners();
      await Promise.all([direct.terminate(), owned.terminate()]);
      expect(getTrackedWorkerLifecycleSnapshot().workerCount).toBe(initial.workerCount);
      const retired = sampleTrackedWorkerMemory();
      expect(retired).toEqual({ ...initial, workerLifecycle: retired.workerLifecycle });
      for (const [name, reason] of [
        ["other", "exit"],
        [script, "idle_timeout"],
      ] as const) {
        expect(retiredCount(retired, name, reason)).toBe(retiredCount(initial, name, reason) + 1);
      }
      expect(sampleTrackedWorkerMemory().workerLifecycle).toEqual(retired.workerLifecycle);
    },
  );

  it("bounds outstanding heap reads and excludes stale samples during a native stall", async () => {
    const worker = await createWorker();
    const native = await worker.getHeapStatistics();
    const stalled = createDeferredCore<typeof native>();
    const read = vi
      .spyOn(worker, "getHeapStatistics")
      .mockResolvedValueOnce(native)
      .mockReturnValue(stalled.promise);
    expect((await sampledMemory()).workerHeaps).toEqual([
      expect.objectContaining({
        script: "other",
        heapUsed: native.used_heap_size,
        heapTotal: native.total_heap_size,
        heapSizeLimitBytes: process.versions.bun ? undefined : native.heap_size_limit,
      }),
    ]);
    const now = performance.now();
    vi.spyOn(performance, "now").mockReturnValue(now + 60_001);
    for (let index = 0; index < 10; index++) {
      expect(sampleTrackedWorkerMemory()).toMatchObject({
        workerCount: 1,
        workerHeapSampledCount: 0,
        workerHeapTotalBytes: undefined,
        workerHeapUsedBytes: undefined,
        workerExternalBytes: undefined,
        workerMemoryCoverage: "unavailable",
        workerMemoryMissing: [{ script: "other", threadId: worker.threadId, reason: "stale" }],
        workerHeaps: [],
      });
    }
    expect(read).toHaveBeenCalledTimes(2);
    await worker.terminate();
    stalled.resolve(native);
    await stalled.promise;
    expect(sampleTrackedWorkerMemory().workerCount).toBe(0);
  });

  it("publishes live task-worker heap and buffers, bounds stalled samples, and closes at exit", async () => {
    const published = createDeferredCore<{
      port: MessagePort;
      worker: Worker;
      sample: WorkerMemorySample;
    }>();
    let attached = false;
    const onWorker = (worker: Worker) => {
      worker.on("message", (message: { status?: string; port?: MessagePort }) => {
        if (message.status === "memory" && message.port instanceof MessagePort) {
          attached = true;
          const port = message.port;
          void once(port, "message").then(
            ([sample]) => published.resolve({ port, worker, sample }),
            published.reject,
          );
        } else if (message.status === "ok" && !attached) {
          published.reject(new Error("Task completed without worker memory publication"));
        }
      });
    };
    process.once("worker", onWorker);
    const pool = new WorkerTaskPool<
      { gate?: SharedArrayBuffer; receipt?: MessagePort },
      { threadId: number; checksum: number }
    >({
      workerUrl: new URL("./worker-cpu.test-support.ts", import.meta.url),
      maxWorkers: 1,
    });
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const receipt = new MessageChannel();
    let busy: Promise<{ threadId: number; checksum: number }> | undefined;
    let completeNative: (() => void) | undefined;
    try {
      const task = pool.run({}, {});
      void task.catch(published.reject);
      const { port, worker, sample } = await published.promise;
      const refreshed = once(port, "message");
      const result = await task;
      expect(result.checksum).toBe(14);
      expect(sample.heapUsed).toBeGreaterThan(0);
      expect(sample.external).toBeGreaterThanOrEqual(retainedBytes);
      expect(sample.arrayBuffers).toBeGreaterThanOrEqual(retainedBytes);
      expect(sample.retainedData).toEqual([
        { structure: "catalog-source", entries: 1, approximateBytes: retainedBytes },
      ]);
      if (process.versions.bun) {
        expect(sample.heapSpaces).toBeUndefined();
      } else {
        expect(
          sample.heapSpaces?.find((space) => space.space_name === "old_space")?.space_used_size,
        ).toBeGreaterThan(0);
      }
      const memory = sampleTrackedWorkerMemory();
      expect(memory.workerHeaps).toContainEqual(
        expect.objectContaining({ threadId: result.threadId, ...sample }),
      );
      expect(memory.workerHeapUsedBytes).toBeGreaterThan(0);
      expect(memory.workerArrayBuffersBytes).toBeGreaterThanOrEqual(retainedBytes);
      expect(memory.workerMemoryCoverage).toBe("complete");
      await refreshed;
      const entered = once(receipt.port1, "message");
      busy = pool.run(
        { gate: gate.buffer, receipt: receipt.port2 },
        { transferList: () => [receipt.port2] },
      );
      await entered;
      const send = vi.spyOn(port, "postMessage");
      const read = vi.spyOn(worker, "getHeapStatistics");
      vi.spyOn(performance, "now").mockReturnValue(performance.now() + 60_001);
      expect(sampleTrackedWorkerMemory()).toMatchObject({
        workerHeapUsedBytes: undefined,
        workerArrayBuffersBytes: undefined,
        workerMemoryCoverage: "unavailable",
      });
      expect(read).toHaveBeenCalledTimes(1);
      const native = await read.mock.results[0]!.value;
      expect(sample.heapSizeLimitBytes).toBe(
        process.versions.bun ? undefined : native.heap_size_limit,
      );
      const late = createDeferredCore<NativeHeap>();
      completeNative = () => late.resolve(native);
      read.mockReturnValueOnce(late.promise);
      for (let index = 0; index < 3; index++) {
        expect(sampleTrackedWorkerMemory()).toMatchObject({
          workerHeapUsedBytes: native.used_heap_size,
          workerExternalBytes: native.external_memory,
          workerArrayBuffersBytes: undefined,
          workerMemoryCoverage: "partial",
          workerMemoryMissing: [],
        });
      }
      expect(native.used_heap_size).toBeGreaterThan(0);
      expect(native.external_memory).toBeGreaterThanOrEqual(retainedBytes);
      expect(sampleTrackedWorkerMemory().workerHeaps[0]?.heapSpaces).toBeUndefined();
      expect(sampleTrackedWorkerMemory().workerHeaps[0]?.retainedData).toBeUndefined();
      expect(send).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledTimes(2);
      const recovered = once(port, "message");
      Atomics.store(gate, 0, 1);
      await busy;
      await recovered;
      completeNative();
      await late.promise;
      expect(sampleTrackedWorkerMemory()).toMatchObject({ workerMemoryCoverage: "complete" });
      expect(sampleTrackedWorkerMemory().workerArrayBuffersBytes).toBeGreaterThanOrEqual(
        retainedBytes,
      );
      const closed = once(port, "close");
      const beforeClose = getTrackedWorkerLifecycleSnapshot();
      await pool.close(undefined, "eviction");
      await closed;
      expect(sampleTrackedWorkerMemory()).toMatchObject({ workerCount: 0, workerHeapUsedBytes: 0 });
      const afterClose = getTrackedWorkerLifecycleSnapshot();
      expect(
        retiredCount(afterClose, "other", "eviction") -
          retiredCount(beforeClose, "other", "eviction"),
      ).toBe(1);
    } finally {
      Atomics.store(gate, 0, 1);
      completeNative?.();
      await busy;
      receipt.port1.close();
      receipt.port2.close();
      process.off("worker", onWorker);
      await pool.close();
    }
  });

  it.each(["stall", "recovery"])("owns native counter reads through %s", async (mode) => {
    const initial = getTrackedWorkerCpuSources();
    const worker = await createWorker();
    const cpuUsage = vi.spyOn(worker, "cpuUsage");
    const tracked = getTrackedWorkerCpuSources();
    const source = tracked.workers.at(-1)!;
    if (mode === "recovery") {
      cpuUsage
        .mockRejectedValueOnce(new Error("not running"))
        .mockImplementationOnce(() => {
          throw new Error("unsupported");
        })
        .mockResolvedValue({ user: 100, system: 10 });
      await expect(source.cpuUsage()).resolves.toBeUndefined();
      await expect(source.cpuUsage()).resolves.toBeUndefined();
      await expect(source.cpuUsage()).resolves.toEqual({ user: 100, system: 10 });
      expect(cpuUsage).toHaveBeenCalledTimes(3);
      return;
    }
    const read = createDeferredCore<NodeJS.CpuUsage>();
    cpuUsage.mockReturnValue(read.promise);
    expect(tracked.workers).toHaveLength(initial.workers.length + 1);
    const pending = source.cpuUsage();
    await expect(source.cpuUsage()).resolves.toBeUndefined();
    await expect(getTrackedWorkerCpuSources().workers.at(-1)!.cpuUsage()).resolves.toBeUndefined();
    expect(cpuUsage).toHaveBeenCalledTimes(1);
    await worker.terminate();
    expect(getTrackedWorkerCpuSources().workers).toEqual(initial.workers);
    expect(getTrackedWorkerCpuSources().revision).toBeGreaterThan(tracked.revision);
    read.resolve({ user: 100, system: 10 });
    await pending;
    expect(getTrackedWorkerCpuSources().workers).toEqual(initial.workers);
  });
});
