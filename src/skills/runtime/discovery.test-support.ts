import fs from "node:fs/promises";
import { vi } from "vitest";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";

export async function completePassiveScan(milliseconds = 30 * 60_000 + 50) {
  const accesses = vi.spyOn(fs, "access");
  const tasks = vi.spyOn(WorkerTaskPool.prototype, "run");
  try {
    let settledTasks = 0;
    let settledAccesses = 0;
    for (let elapsed = 0; elapsed < milliseconds; elapsed += 60_000) {
      await vi.advanceTimersByTimeAsync(Math.min(60_000, milliseconds - elapsed));
      // Recovery checks complete on libuv after the fake timer callback returns.
      while (settledAccesses < accesses.mock.results.length) {
        const pending = accesses.mock.results.slice(settledAccesses);
        settledAccesses += pending.length;
        await Promise.allSettled(pending.map((result) => result.value));
      }
      // Native events during a scan can start another pass before publication.
      while (settledTasks < tasks.mock.results.length) {
        const pending = tasks.mock.results.slice(settledTasks);
        settledTasks += pending.length;
        await Promise.all(pending.map((result) => result.value));
      }
    }
  } finally {
    accesses.mockRestore();
    tasks.mockRestore();
  }
}
