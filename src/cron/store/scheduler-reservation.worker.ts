import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { describeUnavailableCronAgent } from "../agent-availability.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { tryCronScheduleIdentity } from "../schedule-identity.js";
import {
  isJobEnabled,
  recomputeJobNextRunAtMs,
  resolveNextRunAtMsOrDisable,
} from "../service/jobs-scheduling.js";
import type { CronJobPolicyContext } from "../service/state.js";
import type { CronJob } from "../types.js";
import {
  assertCronRunReceiptCurrentInDatabase,
  CronRunReceiptRevisionError,
  findActiveCronRunReceiptInDatabase,
  finishCronRunReceiptInDatabase,
} from "./run-receipt-store.js";
import type { CronRuntimeMutationContracts } from "./runtime-mutation.types.js";
import {
  createCronMutationLogger,
  admitCronRuntimeMutation,
  retainCronRuntimeMutationOutcome,
} from "./runtime-mutation.worker.js";
import { mutateCronRuntimeRowsInDatabase } from "./runtime-rows.kernel.js";
import type { CronRuntimeWorkerOperations } from "./runtime-worker.types.js";

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

/** One transaction owner releases reservations; each policy keeps its receipt and marker predicate. */
export function releaseCronReservationsInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.releaseReservations"]["input"],
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
          if (
            policy.kind === "general" &&
            policy.requireCurrentReceipt &&
            policy.terminal &&
            isAgentDeletionBlocked(policy.terminal.handle.agentId, {}, db)
          ) {
            throw new CronRunReceiptRevisionError(
              policy.terminal.handle.receiptId,
              describeUnavailableCronAgent(policy.terminal.handle.agentId),
              "owner-unavailable",
            );
          }
          const preparation = input.prepared;
          admitCronRuntimeMutation(input.nonce);
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
          const state: CronJobPolicyContext = {
            deps: { nowMs: () => preparation.nowMs, log: createCronMutationLogger(outcome.logs) },
          };
          if (policy.kind === "general" && policy.requireCurrentReceipt && policy.terminal) {
            assertCronRunReceiptCurrentInDatabase({
              database: db,
              handle: policy.terminal.handle,
              resolveAgentId: (job) =>
                resolveCronJobEffectiveAgentId(job, preparation.defaultAgentId),
            });
          }
          if (policy.kind === "startup-settlement") {
            const reservations = new Map(
              preparation.reservations.map((reservation) => [reservation.jobId, reservation]),
            );
            const deferredJobs = new Map(
              policy.deferredJobs.map((deferred) => [deferred.jobId, deferred]),
            );
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
              if (
                policy.kind === "scheduled-ineligible" &&
                (!job || reservation.markerAtMs !== job.state.queuedAtMs)
              ) {
                continue;
              }
              if (policy.kind !== "general" || !policy.terminal) {
                finish(
                  reservation,
                  policy.kind === "scheduled-ineligible"
                    ? "cron scheduled reservation became ineligible"
                    : policy.kind === "manual-abandon"
                      ? "cron manual reservation abandoned before completion"
                      : "cron reservation released before completion",
                );
              }
              if (!job) {
                continue;
              }
              // Scheduled rejection clears only its queue marker, never a running successor.
              const changed =
                policy.kind === "scheduled-ineligible" ||
                clearMatchingReservationMarkers(job, reservation);
              if (policy.kind === "scheduled-ineligible") {
                delete job.state.queuedAtMs;
              }
              if (!changed) {
                continue;
              }
              if (
                policy.kind !== "scheduled-ineligible" &&
                (policy.kind !== "general" || policy.restoreLastError) &&
                reservation.activationPreviousLastError
              ) {
                job.state.lastError = reservation.activationPreviousLastError.value;
              }
              if (
                policy.kind === "general" &&
                policy.recompute &&
                job.enabled &&
                job.state.nextRunAtMs === undefined
              ) {
                recomputeJobNextRunAtMs({
                  state,
                  job,
                  nowMs: preparation.nowMs,
                  deferredNotifications: outcome.notifications,
                });
              }
              outcome.jobs.push(job);
            }
          }
          if (policy.kind === "general" && policy.terminal && !preparation.deferTerminal) {
            finishCronRunReceiptInDatabase({ database: db, receiptSchema, ...policy.terminal });
          }
          if (policy.kind !== "general") {
            for (const notification of outcome.notifications) {
              notification.routing = preparation.notificationRouting;
            }
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
        general: "cron.run-reservation-cleanup",
        "manual-abandon": "cron.manual-reservation-cleanup",
        "scheduled-ineligible": "cron.skipped-reservation-cleanup",
        "startup-settlement": "cron.startup-catchup-state",
      }[policy.kind],
    },
  );
}
