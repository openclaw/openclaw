import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  hasActiveCronRun,
  isJobEnabled,
  recomputeJobNextRunAtMs,
  resolveJobErrorBackoffUntilMs,
} from "../service/jobs-scheduling.js";
import { resolveCronNotificationQueueOwner } from "../service/notification-intents.js";
import type { CronJobPolicyContext } from "../service/state.js";
import { hasMissedCronSlotSinceLastRun, isRunnableJob } from "../service/timer-runnable.js";
import { findActiveCronRunReceiptInDatabase } from "./run-receipt-store.js";
import type { CronRuntimeMutationContracts } from "./runtime-mutation.types.js";
import {
  createCronMutationLogger,
  prepareCronRuntimeMutation,
  retainCronRuntimeMutationOutcome,
} from "./runtime-mutation.worker.js";
import { mutateCronRuntimeRowsInDatabase } from "./runtime-rows.kernel.js";
import type { CronRuntimeWorkerOperations } from "./runtime-worker.types.js";

export function planCronStartupInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.planStartup"]["input"],
): CronRuntimeWorkerOperations["cron.planStartup"]["output"] {
  const skipped = new Set(input.skipJobIds);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const committed = mutateCronRuntimeRowsInDatabase({
        database: db,
        storeKey: input.storeKey,
        jobIds: new Set(input.jobIds),
        mutate({ jobs }) {
          const preparation = prepareCronRuntimeMutation("cron.planStartup", input.nonce, {
            jobIds: [...jobs.keys()],
            notificationNeedsDefault: [...jobs.values()].some(
              (job) =>
                isJobEnabled(job) &&
                !skipped.has(job.id) &&
                !hasActiveCronRun(job, false) &&
                (job.schedule.kind === "cron" || job.schedule.kind === "every") &&
                !resolveCronNotificationQueueOwner(job, "auto-disabled").agentId,
            ),
          });
          const outcome: CronRuntimeMutationContracts["cron.planStartup"]["outcome"] = {
            jobs: [],
            missed: [],
            skippedJobIds: [],
            notifications: [],
            logs: [],
          };
          const state: CronJobPolicyContext = {
            deps: {
              nowMs: () => preparation.nowMs,
              log: createCronMutationLogger(outcome.logs),
            },
          };
          const ownership = new Map(preparation.ownership.map((owner) => [owner.jobId, owner]));
          for (const job of jobs.values()) {
            const owner = ownership.get(job.id);
            if (!owner) {
              throw new Error("Cron startup planning has no prepared process ownership");
            }
            if (
              !isJobEnabled(job) ||
              skipped.has(job.id) ||
              hasActiveCronRun(job, owner.active) ||
              findActiveCronRunReceiptInDatabase({
                database: db,
                storePath: input.storeKey,
                jobId: job.id,
              })
            ) {
              continue;
            }
            const backoffUntilMs =
              job.schedule.kind === "cron"
                ? resolveJobErrorBackoffUntilMs(job, DEFAULT_ERROR_BACKOFF_SCHEDULE_MS)
                : undefined;
            if (
              backoffUntilMs !== undefined &&
              preparation.nowMs < backoffUntilMs &&
              hasMissedCronSlotSinceLastRun(job, preparation.nowMs) &&
              job.state.nextRunAtMs !== backoffUntilMs
            ) {
              job.state.nextRunAtMs = backoffUntilMs;
              outcome.jobs.push(job);
              continue;
            }
            if (
              !isRunnableJob({
                job,
                nowMs: preparation.nowMs,
                skipAtIfAlreadyRan: true,
                allowCronMissedRunByLastRun: true,
                activeInProcess: owner.active,
                legacyDefaultAgentId: preparation.legacyDefaultAgentId,
              })
            ) {
              continue;
            }
            if (
              preparation.skipMissedJobs &&
              (job.schedule.kind === "cron" || job.schedule.kind === "every")
            ) {
              if (
                recomputeJobNextRunAtMs({
                  state,
                  job,
                  nowMs: preparation.nowMs,
                  deferredNotifications: outcome.notifications,
                })
              ) {
                outcome.jobs.push(job);
              }
              outcome.skippedJobIds.push(job.id);
            } else {
              outcome.missed.push(job);
            }
          }
          for (const notification of outcome.notifications) {
            notification.routing = preparation.notificationRouting;
          }
          return { upsertJobIds: outcome.jobs.map((job) => job.id), value: outcome };
        },
      });
      return retainCronRuntimeMutationOutcome("cron.planStartup", db, input.nonce, committed.value);
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.startup-schedules" },
  );
}
