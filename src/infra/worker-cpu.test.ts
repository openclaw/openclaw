import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MessageChannel, MessagePort, Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  getTrackedWorkerCpuSources,
  getTrackedWorkerLifecycleSnapshot,
  createCpuTrackedWorker,
  markWorkerRetirement,
  sampleTrackedWorkerMemory,
} from "./worker-cpu.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

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
  it.each([
    ["sqlite-store.worker.js", "sqlite-store.worker.js"],
    ["sqlite-store.worker.ts", "sqlite-store.worker.js"],
    ["session-history.worker.js", "session-history.worker.js"],
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
      sample: Pick<NodeJS.MemoryUsage, "heapUsed" | "heapTotal" | "external" | "arrayBuffers">;
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

  it("retains native ownership through stalled reads and removes it only at exit", async () => {
    const initial = getTrackedWorkerCpuSources();
    const worker = await createWorker();
    const read = createDeferredCore<NodeJS.CpuUsage>();
    const cpuUsage = vi.spyOn(worker, "cpuUsage").mockReturnValue(read.promise);
    const tracked = getTrackedWorkerCpuSources();
    expect(tracked.workers).toHaveLength(initial.workers.length + 1);
    const source = tracked.workers.at(-1)!;
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

  it("recovers after rejected or synchronously unavailable native counters", async () => {
    const worker = await createWorker();
    const cpuUsage = vi
      .spyOn(worker, "cpuUsage")
      .mockRejectedValueOnce(new Error("not running"))
      .mockImplementationOnce(() => {
        throw new Error("unsupported");
      })
      .mockResolvedValue({ user: 100, system: 10 });
    const source = getTrackedWorkerCpuSources().workers.at(-1)!;
    await expect(source.cpuUsage()).resolves.toBeUndefined();
    await expect(source.cpuUsage()).resolves.toBeUndefined();
    await expect(source.cpuUsage()).resolves.toEqual({ user: 100, system: 10 });
    expect(cpuUsage).toHaveBeenCalledTimes(3);
  });
});
