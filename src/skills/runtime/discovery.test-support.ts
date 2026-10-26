import { vi } from "vitest";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";

export async function completePassiveScan(milliseconds = 30 * 60_000 + 50) {
  const tasks = vi.spyOn(WorkerTaskPool.prototype, "run");
  try {
    let settledTasks = 0;
    for (let elapsed = 0; elapsed < milliseconds; elapsed += 60_000) {
      await vi.advanceTimersByTimeAsync(Math.min(60_000, milliseconds - elapsed));
      // Native events during a scan can start another pass before publication.
      while (settledTasks < tasks.mock.results.length) {
        const pending = tasks.mock.results.slice(settledTasks);
        settledTasks += pending.length;
        await Promise.all(pending.map((result) => result.value));
      }
    }
  } finally {
    tasks.mockRestore();
  }
}
