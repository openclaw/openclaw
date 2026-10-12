import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { isCronJobActive } from "../active-jobs.js";
import { noteCronJobsStoreCommit } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type {
  CronRuntimeMutationContracts,
  CronScheduleMaintenanceOptions,
} from "../store/runtime-worker.types.js";
import { runCronRuntimeMutation } from "./runtime-mutation.js";
import { applyCronRuntimeRowsToState } from "./runtime-publication.js";
import type { CronServiceState } from "./state.js";
import { runPostPersistCronNotifications } from "./store.js";

type MaintenanceOutcome = CronRuntimeMutationContracts["cron.scheduleUnowned"]["outcome"];

/** Capture local activity before dispatch; new activity may race this snapshot. */
export function captureCronScheduleOwnership(jobIds: readonly string[]) {
  return jobIds.map((jobId) => {
    return { jobId, active: isCronJobActive(jobId) };
  });
}

/** Schedules authoritative rows in the worker without clearing live process ownership. */
export async function recomputeUnownedCronSchedules(
  state: CronServiceState,
  opts?: CronScheduleMaintenanceOptions,
): Promise<MaintenanceOutcome> {
  const context = captureOpenClawStateWorkerContext();
  const generation = state.lifecycleGeneration;
  const storeKey = cronStoreKey(state.deps.storePath);
  let outcome: MaintenanceOutcome | undefined;
  await runCronRuntimeMutation({
    context,
    type: "cron.scheduleUnowned",
    input: { storeKey, options: opts ? { ...opts } : undefined },
    assertCurrent() {
      if (state.lifecycleGeneration !== generation) {
        throw new Error("Cron schedule maintenance owner retired");
      }
    },
    snapshot: {
      nowMs: opts?.nowMs ?? state.deps.nowMs(),
      ownership: captureCronScheduleOwnership(state.store?.jobs.map((job) => job.id) ?? []),
    },
    onSettled(result) {
      if (result === "unknown") {
        noteCronJobsStoreCommit(storeKey);
      }
    },
    publish(committed) {
      outcome = committed;
      if (committed.changed) {
        noteCronJobsStoreCommit(storeKey);
      }
      applyCronRuntimeRowsToState(state, committed.jobs);
      for (const entry of committed.logs) {
        state.deps.log[entry.level](entry.fields, entry.message);
      }
    },
  });
  if (!outcome) {
    throw new Error("Cron schedule maintenance did not publish its committed rows");
  }
  await runPostPersistCronNotifications(state, outcome.notifications);
  return outcome;
}
