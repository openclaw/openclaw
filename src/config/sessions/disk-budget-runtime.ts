import path from "node:path";
import { resolveRuntimeProcessEntrypointUrl } from "../../infra/runtime-process-url.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { registerOpenClawAgentDatabaseReadCandidateResource } from "../../state/openclaw-agent-db-resources.js";
import type { SessionPhysicalDiskUsage } from "./disk-budget-files.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";

const measurements = resolveGlobalSingleton<{
  pool: WorkerTaskPool<string, SessionPhysicalDiskUsage>;
  pending: Set<Promise<SessionPhysicalDiskUsage>>;
  draining?: Promise<void>;
}>(
  Symbol.for("openclaw.sessionDiskBudgetWorkers"),
  () => ({
    pool: new WorkerTaskPool<string, SessionPhysicalDiskUsage>({
      workerUrl: resolveRuntimeProcessEntrypointUrl("sessionDiskBudget"),
      workerClass: "reader",
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

/** Captures database cleanup custody, then measures physical artifacts in a worker. */
export async function measureSessionPhysicalDiskUsage(
  storePath: string,
): Promise<SessionPhysicalDiskUsage> {
  // Discovery opens SQLite siblings to verify ownership and can create WAL sidecars.
  // Keep the captured family in close custody through the scan, not just global pool drainage.
  const releases: Array<() => void> = [];
  let pending: Promise<SessionPhysicalDiskUsage> | undefined;
  const close = async () => {
    try {
      await pending;
    } catch {
      // A task can reject before a failed native termination is settled. Keep this
      // resource registered until the pool's retained retirement owner succeeds.
      await measurements.pool.retryFailedRetirements();
    }
    releases.splice(0).forEach((release) => release());
  };
  try {
    for (const candidate of captureSessionStoreReadCandidates(storePath)) {
      for (const pathname of new Set([candidate.path, candidate.physicalPath])) {
        releases.push(
          registerOpenClawAgentDatabaseReadCandidateResource({
            path: pathname,
            scope: candidate.scope,
            // Accepted scans finish before removal; they retain no native handles after reply.
            revoke: () => {},
            close,
          }),
        );
      }
    }
    pending = measurements.pool.run(path.resolve(storePath), {});
    measurements.pending.add(pending);
    return await pending;
  } finally {
    if (pending) {
      measurements.pending.delete(pending);
    }
    await close();
  }
}
