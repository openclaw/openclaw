import { afterEach, expect, it, vi } from "vitest";
import { cancelWorkerIdleGc, scheduleWorkerIdleGc } from "./worker-idle-gc.js";

const { collect, warn } = vi.hoisted(() => {
  const gc = vi.fn(async () => undefined);
  const bun = (globalThis as typeof globalThis & { Bun?: { gc(full: boolean): unknown } }).Bun;
  if (bun) {
    vi.spyOn(bun, "gc").mockImplementation(gc);
  }
  return { collect: gc, warn: vi.fn() };
});

// mock-isolation: Capture worker GC diagnostics without initializing process-wide logging.
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => ({ warn }) }));

vi.mock("node:inspector/promises", () => ({
  Session: class {
    connect = vi.fn();
    post = collect;
  },
}));
vi.mock("node:worker_threads", () => ({ isMainThread: false, threadId: 14 }));

afterEach(() => {
  cancelWorkerIdleGc();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("lets task bursts finish and only schedules collection after heap or external growth", async () => {
  vi.useFakeTimers();
  const memory = process.memoryUsage();
  let heapUsed = 64 * 1024 * 1024;
  let external = memory.external;
  vi.spyOn(process, "memoryUsage").mockImplementation(() => ({ ...memory, heapUsed, external }));

  for (const pauseMs of [250, 750, 999]) {
    scheduleWorkerIdleGc();
    await vi.advanceTimersByTimeAsync(pauseMs);
    expect(collect).not.toHaveBeenCalled();
    cancelWorkerIdleGc();
  }
  await vi.advanceTimersByTimeAsync(1_000);
  expect(collect).not.toHaveBeenCalled();

  scheduleWorkerIdleGc();
  await vi.advanceTimersByTimeAsync(999);
  expect(collect).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(collect).toHaveBeenCalledExactlyOnceWith(
    process.versions.bun ? true : "HeapProfiler.collectGarbage",
  );

  cancelWorkerIdleGc();
  heapUsed += 32 * 1024 * 1024;
  scheduleWorkerIdleGc();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(collect).toHaveBeenCalledTimes(1);

  cancelWorkerIdleGc();
  heapUsed++;
  scheduleWorkerIdleGc();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(collect).toHaveBeenCalledTimes(2);

  // Released buffers need collection even when the preceding JavaScript heap has shrunk.
  cancelWorkerIdleGc();
  heapUsed = 8 * 1024 * 1024;
  external = 64 * 1024 * 1024;
  scheduleWorkerIdleGc();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(collect).toHaveBeenCalledTimes(3);

  cancelWorkerIdleGc();
  external += 32 * 1024 * 1024;
  scheduleWorkerIdleGc();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(collect).toHaveBeenCalledTimes(3);

  cancelWorkerIdleGc();
  external++;
  scheduleWorkerIdleGc();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(collect).toHaveBeenCalledTimes(4);
});

it("names a forced collection slow enough to delay requests posted to the worker", async () => {
  vi.useFakeTimers();
  collect.mockClear();
  const bun = (globalThis as typeof globalThis & { Bun?: { gc(full: boolean): unknown } }).Bun;
  if (bun) {
    vi.spyOn(bun, "gc").mockImplementation(collect);
  }
  const MiB = 1024 * 1024;
  const memory = process.memoryUsage();
  // Stay above any real heap a previous collection may have recorded.
  const baseline = 64 * 1024 * MiB;
  let heapUsed = baseline;
  vi.spyOn(process, "memoryUsage").mockImplementation(() => ({ ...memory, heapUsed }));
  const collectFor = (elapsedMs: number) =>
    collect.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + elapsedMs);
      heapUsed -= 64 * MiB;
    });

  collectFor(999);
  scheduleWorkerIdleGc();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(collect).toHaveBeenCalledTimes(1);
  await vi.dynamicImportSettled();
  expect(warn).not.toHaveBeenCalled();

  heapUsed += 128 * MiB;
  collectFor(2_400);
  scheduleWorkerIdleGc();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(collect).toHaveBeenCalledTimes(2);
  await vi.dynamicImportSettled();
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    "slow idle worker garbage collection",
    expect.objectContaining({
      elapsedMs: 2_400,
      threadId: 14,
      heapUsedBeforeBytes: baseline + 64 * MiB,
      heapUsedAfterBytes: baseline,
    }),
  );
});
