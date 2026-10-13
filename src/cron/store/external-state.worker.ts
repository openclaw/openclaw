import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveFailureAlert } from "../service/failure-alerts.js";
import type { CronJobPolicyContext } from "../service/state.js";
import { applyJobResult } from "../service/timer-outcomes.js";
import { ownsStreamSource } from "../stream-schedule.js";
import { createCronMutationLogger } from "./runtime-mutation.worker.js";
import { mutateCronRuntimeRowsInDatabase } from "./runtime-rows.kernel.js";
import type {
  CronRuntimeMutationContracts,
  CronRuntimeWorkerOperations,
} from "./runtime-worker.types.js";

export function mutateCronExternalStateInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.mutateExternalState"]["input"],
): CronRuntimeWorkerOperations["cron.mutateExternalState"]["output"] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const committed = mutateCronRuntimeRowsInDatabase({
        database: db,
        storeKey: input.storeKey,
        jobIds: new Set([input.jobId]),
        mutate({ jobs }) {
          const job = jobs.get(input.jobId);
          const policy = input.snapshot;
          const outcome: CronRuntimeMutationContracts["cron.mutateExternalState"]["outcome"] = {
            nowMs: policy.nowMs,
            notifications: [],
            logs: [],
          };
          if (!job) {
            return { value: outcome };
          }
          const { change } = input;
          if (
            change.kind !== "counters" &&
            change.source &&
            !ownsStreamSource(job, change.source.scheduleKey, change.source.identity)
          ) {
            return { value: outcome };
          }
          switch (change.kind) {
            case "state":
            case "failure": {
              const sourceIdentity = job.state.streamSourceIdentity;
              Object.assign(job.state, change.statePatch);
              job.state.streamSourceIdentity = sourceIdentity;
              if (change.kind === "failure") {
                const { nowMs, cronConfig } = policy;
                const state: CronJobPolicyContext = {
                  deps: {
                    nowMs: () => nowMs,
                    cronConfig,
                    log: createCronMutationLogger(outcome.logs),
                  },
                  preparedFailureAlert: {
                    jobId: input.jobId,
                    value: resolveFailureAlert({ deps: { cronConfig } }, job),
                  },
                };
                job.state.consecutiveErrors = Math.max(job.state.consecutiveErrors ?? 0, 4);
                applyJobResult(
                  state,
                  job,
                  {
                    status: "error",
                    error: change.error,
                    executionStarted: false,
                    startedAt: nowMs,
                    endedAt: nowMs,
                  },
                  { deferredNotifications: outcome.notifications },
                );
                job.state.nextRunAtMs = undefined;
              }
              break;
            }
            case "retire":
              job.state.streamSourceIdentity = change.nextIdentity;
              break;
            case "counters":
              if (job.schedule.kind !== "stream") {
                return { value: outcome };
              }
              job.state.streamDroppedBatches = Math.max(
                job.state.streamDroppedBatches ?? 0,
                change.counters.streamDroppedBatches ?? 0,
              );
              job.state.streamCoalescedBatches = Math.max(
                job.state.streamCoalescedBatches ?? 0,
                change.counters.streamCoalescedBatches ?? 0,
              );
              break;
          }
          outcome.job = job;
          return { upsertJobIds: [job.id], value: outcome };
        },
      });
      return { outcome: committed.value };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    {
      operationLabel: {
        state: "cron.external-state",
        retire: "cron.retire-stream-source",
        counters: "cron.external-counters",
        failure: "cron.external-failure",
      }[input.change.kind],
    },
  );
}
