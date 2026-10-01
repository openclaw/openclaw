import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { tryCronScheduleIdentity } from "../schedule-identity.js";
import { isJobEnabled } from "../service/jobs-scheduling.js";
import { resolveCronNotificationQueueOwner } from "../service/notification-intents.js";
import type { CronJobPolicyContext } from "../service/state.js";
import { resolveNextRunAtMsOrDisable } from "../service/timer-trigger.js";
import type { CronJob } from "../types.js";
import {
  findActiveCronRunReceiptInDatabase,
  finishCronRunReceiptInDatabase,
} from "./run-receipt-store.js";
import type { CronRuntimeMutationContracts } from "./runtime-mutation.types.js";
import {
  createCronMutationLogger,
  prepareCronRuntimeMutation,
  retainCronRuntimeMutationOutcome,
} from "./runtime-mutation.worker.js";
import { mutateCronRuntimeRowsInDatabase } from "./runtime-rows.kernel.js";
import type {
  CronReservationReleasePolicy,
  CronRuntimeWorkerOperations,
} from "./runtime-worker.types.js";

type SchedulerReleasePolicy = Exclude<CronReservationReleasePolicy, { kind: "general" }>;
type SchedulerReleaseInput = Omit<
  CronRuntimeWorkerOperations["cron.releaseReservations"]["input"],
  "policy"
> & { policy: SchedulerReleasePolicy };
type PreparedReservation =
  CronRuntimeMutationContracts["cron.releaseReservations"]["preparation"]["reservations"][number];

function clearMatchingReservationMarkers(job: CronJob, reservation: PreparedReservation): boolean {
  let changed = false;
  if (reservation.markerAtMs === job.state.queuedAtMs) {
    delete job.state.queuedAtMs;
    changed = true;
  }
  if (reservation.markerAtMs === job.state.runningAtMs) {
    delete job.state.runningAtMs;
    delete job.state.runningReceiptId;
    delete job.state.runningScheduleChangeId;
    changed = true;
  }
  return changed;
}

/** Named scheduler cleanup policies retain their distinct marker and receipt predicates. */
export function releaseSchedulerReservationsInWorker(
  database: OpenClawStateDatabase,
  input: SchedulerReleaseInput,
): CronRuntimeWorkerOperations["cron.releaseReservations"]["output"] {
  const { policy } = input;
  const jobIds = new Set([
    ...input.jobIds,
    ...(policy.kind === "startup-settlement" ? policy.deferredJobs.map((job) => job.jobId) : []),
  ]);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const committed = mutateCronRuntimeRowsInDatabase({
        database: db,
        storeKey: input.storeKey,
        jobIds,
        mutate({ jobs, receiptSchema }) {
          const preparation = prepareCronRuntimeMutation("cron.releaseReservations", input.nonce, {
            deletionBlocked: false,
            notificationNeedsDefault:
              policy.kind === "startup-settlement" &&
              policy.deferredJobs.some(({ jobId }) => {
                const job = jobs.get(jobId);
                return (
                  job !== undefined &&
                  isJobEnabled(job) &&
                  !resolveCronNotificationQueueOwner(job, "auto-disabled").agentId
                );
              }),
          });
          const outcome: CronRuntimeMutationContracts["cron.releaseReservations"]["outcome"] = {
            jobs: [],
            notifications: [],
            logs: [],
          };
          const finish = (reservation: PreparedReservation, error: string) => {
            finishCronRunReceiptInDatabase({
              receiptSchema,
              database: db,
              handle: reservation.runReceipt,
              status: "skipped",
              finishedAtMs: preparation.nowMs,
              error,
            });
          };
          if (policy.kind === "startup-settlement") {
            const reservations = new Map(
              preparation.reservations.map((reservation) => [reservation.jobId, reservation]),
            );
            const deferredJobs = new Map(
              policy.deferredJobs.map((deferred) => [deferred.jobId, deferred]),
            );
            const state: CronJobPolicyContext = {
              deps: {
                nowMs: () => preparation.nowMs,
                log: createCronMutationLogger(outcome.logs),
              },
            };
            let offset = policy.staggerMs;
            // Native row order owns pacing; refused deferrals do not consume an offset.
            for (const job of jobs.values()) {
              let changed = false;
              const reservation = reservations.get(job.id);
              if (reservation) {
                finish(reservation, "cron startup reservation abandoned before completion");
                if (reservation.activationPreviousLastError) {
                  job.state.lastError = reservation.activationPreviousLastError.value;
                }
                changed = clearMatchingReservationMarkers(job, reservation);
              }
              const deferred = deferredJobs.get(job.id);
              if (
                deferred &&
                isJobEnabled(job) &&
                job.state.queuedAtMs === undefined &&
                job.state.runningAtMs === undefined &&
                job.state.nextRunAtMs === deferred.nextRunAtMs &&
                job.state.lastRunAtMs === deferred.lastRunAtMs &&
                job.state.lastRunStatus === deferred.lastRunStatus &&
                job.state.scheduleActivatedAtMs === deferred.scheduleActivatedAtMs &&
                job.createdAtMs === deferred.createdAtMs &&
                job.payload.kind === deferred.payloadKind &&
                deferred.scheduleIdentity !== undefined &&
                tryCronScheduleIdentity(job) === deferred.scheduleIdentity &&
                !findActiveCronRunReceiptInDatabase({
                  database: db,
                  storePath: input.storeKey,
                  jobId: job.id,
                })
              ) {
                const candidate =
                  typeof deferred.delayMs === "number"
                    ? preparation.nowMs + deferred.delayMs + offset - policy.staggerMs
                    : preparation.nowMs + offset;
                const runAtMs = resolveNextRunAtMsOrDisable({
                  state,
                  job,
                  candidate,
                  deferredNotifications: outcome.notifications,
                });
                job.state.nextRunAtMs = runAtMs;
                job.state.startupCatchupAtMs = runAtMs;
                offset += policy.staggerMs;
                changed = true;
              }
              if (changed) {
                outcome.jobs.push(job);
              }
            }
          } else {
            for (const reservation of preparation.reservations) {
              const job = jobs.get(reservation.jobId);
              if (policy.kind === "scheduled-ineligible") {
                if (!job || reservation.markerAtMs !== job.state.queuedAtMs) {
                  continue;
                }
                finish(reservation, "cron scheduled reservation became ineligible");
                delete job.state.queuedAtMs;
              } else {
                finish(reservation, "cron manual reservation abandoned before completion");
                if (!job || !clearMatchingReservationMarkers(job, reservation)) {
                  continue;
                }
                if (reservation.activationPreviousLastError) {
                  job.state.lastError = reservation.activationPreviousLastError.value;
                }
              }
              outcome.jobs.push(job);
            }
          }
          for (const notification of outcome.notifications) {
            notification.routing = preparation.notificationRouting;
          }
          return { upsertJobIds: outcome.jobs.map((job) => job.id), value: outcome };
        },
      });
      return retainCronRuntimeMutationOutcome(
        "cron.releaseReservations",
        db,
        input.nonce,
        committed.value,
      );
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    {
      operationLabel: {
        "manual-abandon": "cron.manual-reservation-cleanup",
        "scheduled-ineligible": "cron.skipped-reservation-cleanup",
        "startup-settlement": "cron.startup-catchup-state",
      }[policy.kind],
    },
  );
}
