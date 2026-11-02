import { afterEach, expect, it, vi } from "vitest";
import { cancelWorkerIdleGc, scheduleWorkerIdleGc } from "./worker-idle-gc.js";

const { collect } = vi.hoisted(() => ({ collect: vi.fn(async () => undefined) }));

vi.mock("node:inspector/promises", () => ({
  Session: class {
    connect = vi.fn();
    post = collect;
  },
}));
vi.mock("node:worker_threads", () => ({ isMainThread: false }));

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
  expect(collect).toHaveBeenCalledExactlyOnceWith("HeapProfiler.collectGarbage");

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
