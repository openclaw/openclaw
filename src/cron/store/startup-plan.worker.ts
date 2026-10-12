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
import type { CronJobPolicyContext } from "../service/state.js";
import { hasMissedCronSlotSinceLastRun, isRunnableJob } from "../service/timer-runnable.js";
import { findActiveCronRunReceiptInDatabase } from "./run-receipt-store.js";
import { createCronMutationLogger } from "./runtime-mutation.worker.js";
import { mutateCronRuntimeRowsInDatabase } from "./runtime-rows.kernel.js";
import type {
  CronRuntimeMutationContracts,
  CronRuntimeWorkerOperations,
} from "./runtime-worker.types.js";

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
          const policy = input.snapshot;
          const outcome: CronRuntimeMutationContracts["cron.planStartup"]["outcome"] = {
            jobs: [],
            missed: [],
            skippedJobIds: [],
            notifications: [],
            logs: [],
          };
          const state: CronJobPolicyContext = {
            deps: {
              nowMs: () => policy.nowMs,
              log: createCronMutationLogger(outcome.logs),
            },
          };
          const ownership = new Map(policy.ownership.map((owner) => [owner.jobId, owner]));
          for (const job of jobs.values()) {
            const owner = ownership.get(job.id);
            if (
              !isJobEnabled(job) ||
              skipped.has(job.id) ||
              hasActiveCronRun(job, owner?.active ?? false) ||
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
              policy.nowMs < backoffUntilMs &&
              hasMissedCronSlotSinceLastRun(job, policy.nowMs) &&
              job.state.nextRunAtMs !== backoffUntilMs
            ) {
              job.state.nextRunAtMs = backoffUntilMs;
              outcome.jobs.push(job);
              continue;
            }
            if (
              !isRunnableJob({
                job,
                nowMs: policy.nowMs,
                skipAtIfAlreadyRan: true,
                allowCronMissedRunByLastRun: true,
                activeInProcess: owner?.active ?? false,
              })
            ) {
              continue;
            }
            if (
              policy.skipMissedJobs &&
              (job.schedule.kind === "cron" || job.schedule.kind === "every")
            ) {
              if (
                recomputeJobNextRunAtMs({
                  state,
                  job,
                  nowMs: policy.nowMs,
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
            notification.routing = policy.notificationRouting;
          }
          return { upsertJobIds: outcome.jobs.map((job) => job.id), value: outcome };
        },
      });
      return { outcome: committed.value };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.startup-schedules" },
  );
}
