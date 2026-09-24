import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { isCronJobActive } from "../active-jobs.js";
import { noteCronJobsStoreCommit } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronRuntimeMutationContracts } from "../store/runtime-mutation.types.js";
import type { CronScheduleMaintenanceOptions } from "../store/runtime-worker.types.js";
import { runCronRuntimeMutation } from "./runtime-mutation.js";
import { applyCronRuntimeRowsToState } from "./runtime-store.js";
import type { CronServiceState } from "./state.js";
import { runPostPersistCronNotifications } from "./store.js";

type MaintenanceOutcome = CronRuntimeMutationContracts["cron.scheduleUnowned"]["outcome"];

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
    prepare({ jobIds }) {
      const owners = jobIds.map((jobId) => ({
        jobId,
        active: isCronJobActive(jobId),
        reservation: state.queuedRunReservationsByJobId.get(jobId),
      }));
      const ownership = owners.map(({ jobId, active, reservation }) => ({
        jobId,
        active,
        reservation: reservation
          ? {
              markerAtMs: reservation.markerAtMs,
              preserveWhenDisabled: reservation.preserveWhenDisabled,
            }
          : undefined,
      }));
      return {
        value: { nowMs: opts?.nowMs ?? state.deps.nowMs(), ownership },
        assertCurrent() {
          for (let index = 0; index < owners.length; index += 1) {
            const owner = owners[index]!;
            const prepared = ownership[index]!;
            const current = state.queuedRunReservationsByJobId.get(owner.jobId);
            if (
              owner.active !== isCronJobActive(owner.jobId) ||
              current !== owner.reservation ||
              current?.markerAtMs !== prepared.reservation?.markerAtMs ||
              current?.preserveWhenDisabled !== prepared.reservation?.preserveWhenDisabled
            ) {
              throw new Error("Cron schedule ownership changed before commit");
            }
          }
        },
      };
    },
    publish(committed) {
      outcome = committed;
      if (committed.changed) {
        noteCronJobsStoreCommit(storeKey);
      }
      applyCronRuntimeRowsToState(state, committed.jobs);
      runPostPersistCronNotifications(state, committed.notifications);
      for (const entry of committed.logs) {
        state.deps.log[entry.level](entry.fields, entry.message);
      }
    },
  });
  if (!outcome) {
    throw new Error("Cron schedule maintenance did not publish its committed rows");
  }
  return outcome;
}
