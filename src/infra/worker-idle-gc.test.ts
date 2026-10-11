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

it("lets task bursts finish before collecting and retains the heap-growth threshold", async () => {
  vi.useFakeTimers();
  const memory = process.memoryUsage();
  let heapUsed = 64 * 1024 * 1024;
  vi.spyOn(process, "memoryUsage").mockImplementation(() => ({ ...memory, heapUsed }));

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
  await vi.advanceTimersByTimeAsync(1_000);
  expect(collect).toHaveBeenCalledTimes(1);

  cancelWorkerIdleGc();
  heapUsed++;
  scheduleWorkerIdleGc();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(collect).toHaveBeenCalledTimes(2);
});
