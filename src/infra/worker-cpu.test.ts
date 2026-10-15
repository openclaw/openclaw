import { EventEmitter, once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getHeapStatistics } from "node:v8";
import { MessageChannel, MessagePort, Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  getTrackedWorkerCpuSources,
  getTrackedWorkerLifecycleSnapshot,
  createCpuTrackedWorker,
  markWorkerRetirement,
  trackNativeWorkerForCpu,
  sampleTrackedWorkerMemory,
} from "./worker-cpu.js";
import { getWorkerMessageMetrics } from "./worker-message-metrics.js";
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
  vi.restoreAllMocks();
});

const idleSource = 'require("node:worker_threads").parentPort.on("message", () => {});';

async function createWorker(filename?: URL) {
  const worker = createCpuTrackedWorker(filename ?? idleSource, { eval: !filename });
  workers.push(worker);
  await once(worker, "online");
  return worker;
}

describe("worker CPU lifecycle", () => {
  it("keeps Code Mode slots until native exit and bounds them across worker churn", async () => {
    const handles: (EventEmitter & {
      threadId: number;
      cpuUsage: Worker["cpuUsage"];
      getHeapStatistics: Worker["getHeapStatistics"];
    })[] = [];
    const register = () => {
      const worker = Object.assign(new EventEmitter(), {
        threadId: handles.length + 1000,
        cpuUsage: async () => ({ user: 0, system: 0 }),
        getHeapStatistics: async () => getHeapStatistics(),
      });
      handles.push(worker);
      trackNativeWorkerForCpu(
        worker,
        new URL("../agents/code-mode-node.worker.ts", import.meta.url),
      );
      return worker;
    };
    try {
      for (let index = 0; index < 65; index++) {
        register();
      }
      sampleTrackedWorkerMemory();
      await Promise.resolve();
      const initial = sampleTrackedWorkerMemory().workerHeaps;
      expect(initial.map((worker) => worker.workerSlot)).toEqual([
        ...Array.from({ length: 64 }, (_, index) => index + 1),
        undefined,
      ]);
      markWorkerRetirement(handles[0]!, "idle_timeout");
      const retiring = register();
      sampleTrackedWorkerMemory();
      await Promise.resolve();
      expect(
        sampleTrackedWorkerMemory().workerHeaps.find(
          (worker) => worker.threadId === retiring.threadId,
        )?.workerSlot,
      ).toBeUndefined();
      handles[0]!.emit("exit");
      const replacement = register();
      sampleTrackedWorkerMemory();
      await Promise.resolve();
      const live = sampleTrackedWorkerMemory().workerHeaps;
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
      const file = join(tempDirs.make("worker-heartbeat-metrics-"), script);
      await writeFile(
        file,
        `const { parentPort } = require("node:worker_threads"); parentPort.on("message", () => parentPort.postMessage(${JSON.stringify(response)}));`,
      );
      const worker = await createWorker(pathToFileURL(file));
      const before = getWorkerMessageMetrics();
      const reply = once(worker, "message");
      worker.postMessage(request, []);
      expect(await reply).toEqual([response]);
      const after = getWorkerMessageMetrics();
      for (const direction of ["to_worker", "from_worker"] as const) {
        const previous = before.find(
          (row) => row.kind === "lifecycle" && row.direction === direction,
        );
        expect(
          after.find((row) => row.kind === "lifecycle" && row.direction === direction)?.messages,
        ).toBe((previous?.messages ?? 0) + 1);
      }
      expect(after.filter((row) => row.kind === "sqlite_reply")).toEqual(
        before.filter((row) => row.kind === "sqlite_reply"),
      );
    },
  );

  it("attributes dedicated reclamation requests and replies once at the native boundary", async () => {
    const before = getWorkerMessageMetrics();
    const worker = createCpuTrackedWorker(
      'const { parentPort } = require("node:worker_threads"); parentPort.on("message", ({ operationId }) => parentPort.postMessage({ type: "reclaimed", operationId, settled: true, result: {} }));',
      { eval: true },
    );
    workers.push(worker);
    await once(worker, "online");
    const reply = once(worker, "message");
    worker.postMessage({ type: "reclaim", operationId: 1, plan: {}, coordination: {} }, []);
    expect(await reply).toEqual([{ type: "reclaimed", operationId: 1, settled: true, result: {} }]);
    for (const [kind, direction] of [
      ["sqlite_request", "to_worker"],
      ["sqlite_reply", "from_worker"],
    ] as const) {
      const previous = before.find((row) => row.kind === kind && row.direction === direction);
      expect(getWorkerMessageMetrics()).toContainEqual({
        kind,
        direction,
        messages: (previous?.messages ?? 0) + 1,
        payloadBytes: previous?.payloadBytes ?? 0,
        unmeasuredMessages: (previous?.unmeasuredMessages ?? 0) + 1,
      });
    }
  });

  it.each([
    ["postMessage", "accessor"],
    ["emit", "accessor"],
    ["postMessage", "readonly"],
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
    const worker = new ReadOnlyWorker(
      'const { parentPort } = require("node:worker_threads"); parentPort.on("message", (value) => parentPort.postMessage(value));',
      { eval: true },
    );
    workers.push(worker);
    if (method === "postMessage") {
      expect(getter).not.toHaveBeenCalled();
    }
    await once(worker, "online");
    const reply = once(worker, "message");
    worker.postMessage("round trip", []);
    expect(await reply).toEqual(["round trip"]);
  });

  it.each(["dependency", "factory"])(
    "counts %s Workers without inspecting their payload accessors",
    async (mode) => {
      const metric = () =>
        getWorkerMessageMetrics().find(
          (entry) => entry.kind === "other" && entry.direction === "to_worker",
        );
      const before = metric();
      const source =
        'const { parentPort } = require("node:worker_threads"); parentPort.on("message", (value) => parentPort.postMessage(value));';
      const worker =
        mode === "dependency"
          ? new Worker(source, { eval: true })
          : createCpuTrackedWorker(source, { eval: true });
      workers.push(worker);
      await once(worker, "online");
      const input = vi.fn(() => "payload");
      const reply = once(worker, "message");
      worker.postMessage(
        {
          get input() {
            return input();
          },
        },
        [],
      );
      expect(await reply).toEqual([{ input: "payload" }]);
      expect(input).toHaveBeenCalledTimes(1);
      expect(metric()).toEqual({
        kind: "other",
        direction: "to_worker",
        messages: (before?.messages ?? 0) + 1,
        payloadBytes: before?.payloadBytes ?? 0,
        unmeasuredMessages: (before?.unmeasuredMessages ?? 0) + 1,
      });
    },
  );

  it("counts native messages once and measures transferred bytes before detachment", async () => {
    const metric = (direction: "to_worker" | "from_worker") =>
      getWorkerMessageMetrics().find(
        (entry) => entry.kind === "sqlite_request" && entry.direction === direction,
      );
    const beforeSend = metric("to_worker");
    const beforeReceive = metric("from_worker");
    const worker = createCpuTrackedWorker(
      'const { parentPort } = require("node:worker_threads"); parentPort.on("message", (value) => parentPort.postMessage(value));',
      { eval: true },
    );
    workers.push(worker);
    await once(worker, "online");
    const post = vi.spyOn(Worker.prototype, "postMessage");
    const emit = vi.spyOn(Worker.prototype, "emit");
    const input = new Uint8Array([1, 2, 3]);
    const received = once(worker, "message");
    worker.postMessage({ type: "execute", actor: 1, id: 1, input }, [input.buffer]);
    expect(input.byteLength).toBe(0);
    expect(post).toHaveBeenCalledTimes(1);
    expect(await received).toEqual([
      { type: "execute", actor: 1, id: 1, input: new Uint8Array([1, 2, 3]) },
    ]);
    expect(emit).toHaveBeenCalledWith("message", {
      type: "execute",
      actor: 1,
      id: 1,
      input: new Uint8Array([1, 2, 3]),
    });
    expect(() => worker.postMessage({ type: "execute", actor: 1, input() {} }, [])).toThrow();
    expect(metric("to_worker")).toEqual({
      kind: "sqlite_request",
      direction: "to_worker",
      messages: (beforeSend?.messages ?? 0) + 1,
      payloadBytes: (beforeSend?.payloadBytes ?? 0) + 3,
      unmeasuredMessages: beforeSend?.unmeasuredMessages ?? 0,
    });
    expect(metric("from_worker")).toEqual({
      kind: "sqlite_request",
      direction: "from_worker",
      messages: (beforeReceive?.messages ?? 0) + 1,
      payloadBytes: (beforeReceive?.payloadBytes ?? 0) + 3,
      unmeasuredMessages: beforeReceive?.unmeasuredMessages ?? 0,
    });
  });

  it.each([
    ["sqlite-store.worker.ts", "sqlite-store.worker.js"],
    ["private-session-worker.js", "other"],
  ])(
    "attributes %s and removes direct and owned Worker samples at native exit",
    async (file, script) => {
      const initial = sampleTrackedWorkerMemory();
      const direct = new Worker(idleSource, { eval: true });
      workers.push(direct);
      await once(direct, "online");
      const filename = join(tempDirs.make("worker-heap-"), file);
      await writeFile(filename, idleSource);
      const owned = await createWorker(pathToFileURL(filename));
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
      expect(memory.workerCount).toBe(initial.workerCount + 2);
      expect(memory.workerHeapSampledCount).toBe(initial.workerHeapSampledCount + 2);
      expect(memory.workerHeapTotalBytes).toBeGreaterThan(memory.workerHeapUsedBytes!);
      expect(memory.workerExternalBytes).toBeGreaterThan(0);
      expect(memory.workerArrayBuffersBytes).toBeUndefined();
      expect(memory.workerMemoryCoverage).toBe("partial");
      expect(memory.workerHeaps).toEqual([
        ...initial.workerHeaps,
        expect.objectContaining({
          script: "other",
          heapUsed: directHeap.used_heap_size,
          heapTotal: directHeap.total_heap_size,
          external: directHeap.external_memory,
        }),
        expect.objectContaining({
          script,
          heapUsed: ownedHeap.used_heap_size,
          heapTotal: ownedHeap.total_heap_size,
          external: ownedHeap.external_memory,
        }),
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
      ]) {
        const before = initial.workerLifecycle.find((entry) => entry.script === name);
        const after = retired.workerLifecycle.find((entry) => entry.script === name);
        expect(after?.retired.find((entry) => entry.reason === reason)?.count).toBe(
          (before?.retired.find((entry) => entry.reason === reason)?.count ?? 0) + 1,
        );
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
    sampleTrackedWorkerMemory();
    await Promise.resolve();
    expect(sampleTrackedWorkerMemory().workerHeaps).toEqual([
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
      sample: Pick<NodeJS.MemoryUsage, "heapUsed" | "heapTotal" | "external" | "arrayBuffers"> & {
        heapSizeLimitBytes?: number;
      };
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
      expect(sample.external).toBeGreaterThanOrEqual(4 * 1024 * 1024);
      expect(sample.arrayBuffers).toBeGreaterThanOrEqual(4 * 1024 * 1024);
      const memory = sampleTrackedWorkerMemory();
      expect(memory.workerHeaps).toContainEqual(
        expect.objectContaining({ threadId: result.threadId, ...sample }),
      );
      expect(memory.workerHeapUsedBytes).toBeGreaterThan(0);
      expect(memory.workerArrayBuffersBytes).toBeGreaterThanOrEqual(4 * 1024 * 1024);
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
      const late = createDeferredCore<Awaited<ReturnType<Worker["getHeapStatistics"]>>>();
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
      expect(native.external_memory).toBeGreaterThanOrEqual(4 * 1024 * 1024);
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
        4 * 1024 * 1024,
      );
      const closed = once(port, "close");
      await pool.close();
      await closed;
      expect(sampleTrackedWorkerMemory()).toMatchObject({ workerCount: 0, workerHeapUsedBytes: 0 });
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
