import { once } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { getTrackedWorkerCpuSources, createCpuTrackedWorker } from "./worker-cpu.js";

const workers: Worker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
  vi.restoreAllMocks();
});

async function createWorker() {
  const worker = createCpuTrackedWorker("setInterval(() => {}, 1000)", { eval: true });
  workers.push(worker);
  await once(worker, "online");
  return worker;
}

describe("worker CPU lifecycle", () => {
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
