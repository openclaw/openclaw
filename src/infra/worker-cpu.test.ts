import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
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
      sampleTrackedWorkerMemory();
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
      expect(memory.workerHeapTotalBytes).toBeGreaterThan(memory.workerHeapUsedBytes);
      expect(memory.workerHeaps).toEqual([
        ...initial.workerHeaps,
        {
          script: "other",
          heapUsed: directHeap.used_heap_size,
          heapTotal: directHeap.total_heap_size,
        },
        {
          script,
          heapUsed: ownedHeap.used_heap_size,
          heapTotal: ownedHeap.total_heap_size,
        },
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
      { script: "other", heapUsed: native.used_heap_size, heapTotal: native.total_heap_size },
    ]);
    const now = performance.now();
    vi.spyOn(performance, "now").mockReturnValue(now + 60_001);
    for (let index = 0; index < 10; index++) {
      expect(sampleTrackedWorkerMemory()).toMatchObject({
        workerCount: 1,
        workerHeapSampledCount: 0,
        workerHeapTotalBytes: 0,
        workerHeapUsedBytes: 0,
        workerHeaps: [],
      });
    }
    expect(read).toHaveBeenCalledTimes(2);
    await worker.terminate();
    stalled.resolve(native);
    await stalled.promise;
    expect(sampleTrackedWorkerMemory().workerCount).toBe(0);
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
