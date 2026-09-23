import path from "node:path";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { SessionPhysicalDiskUsage } from "./disk-budget-files.js";

const measurements = resolveGlobalSingleton<{
  pool: WorkerTaskPool<string, SessionPhysicalDiskUsage>;
  pending: Set<Promise<SessionPhysicalDiskUsage>>;
  draining?: Promise<void>;
}>(
  Symbol.for("openclaw.sessionDiskBudgetWorkers"),
  () => ({
    pool: new WorkerTaskPool<string, SessionPhysicalDiskUsage>({
      workerUrl: resolveRuntimeWorkerUrl({
        currentModuleUrl: import.meta.url,
        sourceWorkerName: "disk-budget.worker",
        distWorkerPath: "config/sessions/disk-budget.worker.js",
      }),
      // Share one scan worker so concurrent stores cannot multiply filesystem scan heaps.
      maxWorkers: 1,
    }),
    pending: new Set<Promise<SessionPhysicalDiskUsage>>(),
  }),
  () => drainSessionDiskBudgetWorkers(),
);

/** Join admitted scans before retiring workers; later measurements reuse the pool. */
export function drainSessionDiskBudgetWorkers(): Promise<void> {
  // A second teardown must join this rotation, not retire its successor worker.
  return (measurements.draining ??= Promise.resolve()
    .then(async () => {
      while (measurements.pending.size > 0) {
        await Promise.allSettled(measurements.pending);
      }
      await measurements.pool.rotate();
    })
    .finally(() => {
      measurements.draining = undefined;
    }));
}

/** Measures physical session artifacts without running per-file synchronous work on the caller. */
export async function measureSessionPhysicalDiskUsage(
  storePath: string,
): Promise<SessionPhysicalDiskUsage> {
  // Capture the locator before queueing; only four totals cross back to the caller.
  const pending = measurements.pool.run(path.resolve(storePath), {});
  measurements.pending.add(pending);
  try {
    return await pending;
  } finally {
    measurements.pending.delete(pending);
  }
}
