import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { tryCronScheduleIdentity } from "../schedule-identity.js";
import { isJobEnabled, resolveNextRunAtMsOrDisable } from "../service/jobs-scheduling.js";
import type { CronJobPolicyContext } from "../service/state.js";
import { findActiveCronRunReceiptInDatabase } from "./run-receipt-store.js";
import { createCronMutationLogger } from "./runtime-mutation.worker.js";
import { mutateCronRuntimeRowsInDatabase } from "./runtime-rows.kernel.js";
import type {
  CronRuntimeMutationContracts,
  CronRuntimeWorkerOperations,
} from "./runtime-worker.types.js";

export function deferCronStartupJobsInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.deferStartupJobs"]["input"],
): CronRuntimeWorkerOperations["cron.deferStartupJobs"]["output"] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const committed = mutateCronRuntimeRowsInDatabase({
        database: db,
        storeKey: input.storeKey,
        jobIds: new Set(input.deferredJobs.map((job) => job.jobId)),
        mutate({ jobs }) {
          const preparation = input.snapshot;
          const outcome: CronRuntimeMutationContracts["cron.deferStartupJobs"]["outcome"] = {
            jobs: [],
            notifications: [],
            logs: [],
          };
          const deferredJobs = new Map(
            input.deferredJobs.map((deferred) => [deferred.jobId, deferred]),
          );
          const state: CronJobPolicyContext = {
            deps: { nowMs: () => preparation.nowMs, log: createCronMutationLogger(outcome.logs) },
          };
          let offset = input.staggerMs;
          // Persisted job order owns pacing; refused deferrals do not consume an offset.
          for (const job of jobs.values()) {
            const deferred = deferredJobs.get(job.id);
            if (
              !deferred ||
              !isJobEnabled(job) ||
              job.state.queuedAtMs !== undefined ||
              job.state.runningAtMs !== undefined ||
              job.state.nextRunAtMs !== deferred.nextRunAtMs ||
              job.state.lastRunAtMs !== deferred.lastRunAtMs ||
              job.state.lastRunStatus !== deferred.lastRunStatus ||
              job.state.scheduleActivatedAtMs !== deferred.scheduleActivatedAtMs ||
              job.createdAtMs !== deferred.createdAtMs ||
              job.payload.kind !== deferred.payloadKind ||
              deferred.scheduleIdentity === undefined ||
              tryCronScheduleIdentity(job) !== deferred.scheduleIdentity ||
              findActiveCronRunReceiptInDatabase({
                database: db,
                storePath: input.storeKey,
                jobId: job.id,
              })
            ) {
              continue;
            }
            const candidate =
              typeof deferred.delayMs === "number"
                ? preparation.nowMs + deferred.delayMs + offset - input.staggerMs
                : preparation.nowMs + offset;
            const runAtMs = resolveNextRunAtMsOrDisable({
              state,
              job,
              candidate,
              deferredNotifications: outcome.notifications,
            });
            job.state.nextRunAtMs = runAtMs;
            job.state.startupCatchupAtMs = runAtMs;
            offset += input.staggerMs;
            outcome.jobs.push(job);
          }
          for (const notification of outcome.notifications) {
            notification.routing = preparation.notificationRouting;
          }
          return { upsertJobIds: outcome.jobs.map((job) => job.id), value: outcome };
        },
      });
      return { outcome: committed.value };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.startup-catchup-state" },
  );
}
