import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
  tryResolveCronJobEffectiveAgentId,
} from "../agent-id.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { resolveFailureAlert } from "../service/failure-alerts.js";
import { hasActiveCronRun } from "../service/jobs-scheduling.js";
import type { CronJobPolicyContext } from "../service/state.js";
import { applyJobResult } from "../service/timer-outcomes.js";
import { findActiveCronRunReceiptInDatabase } from "./run-receipt-store.js";
import { createCronMutationLogger } from "./runtime-mutation.worker.js";
import { mutateCronRuntimeRowsInDatabase } from "./runtime-rows.kernel.js";
import type {
  CronRuntimeMutationContracts,
  CronRuntimeWorkerOperations,
} from "./runtime-worker.types.js";

export function recordSkippedCronRunsInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.recordSkippedRuns"]["input"],
): CronRuntimeWorkerOperations["cron.recordSkippedRuns"]["output"] {
  const { change } = input;
  const proposals = new Map(
    change.kind === "ownerless"
      ? change.proposals.map((proposal) => [proposal.jobId, proposal])
      : [],
  );
  const jobIds = change.kind === "ownerless" ? new Set(proposals.keys()) : new Set([change.jobId]);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const committed = mutateCronRuntimeRowsInDatabase({
        database: db,
        storeKey: input.storeKey,
        jobIds,
        mutate({ jobs }) {
          const policy = input.snapshot;
          const outcome: CronRuntimeMutationContracts["cron.recordSkippedRuns"]["outcome"] = {
            jobs: [],
            rejected: [],
            nowMs: policy.nowMs,
            notifications: [],
            logs: [],
          };
          const ownership = new Map(policy.ownership.map((owner) => [owner.jobId, owner]));
          for (const job of jobs.values()) {
            if (change.kind === "ownerless") {
              const planned = proposals.get(job.id);
              const owner = ownership.get(job.id);
              if (
                !planned ||
                job.enabled !== planned.enabled ||
                job.state.nextRunAtMs !== planned.nextRunAtMs ||
                job.state.lastRunAtMs !== planned.lastRunAtMs ||
                job.state.lastRunStatus !== planned.lastRunStatus ||
                resolveCronJobConfigRevision(job) !== planned.configRevision ||
                hasActiveCronRun(job, owner?.active ?? false) ||
                findActiveCronRunReceiptInDatabase({
                  database: db,
                  storePath: input.storeKey,
                  jobId: job.id,
                }) ||
                tryResolveCronJobEffectiveAgentId(job, policy.defaultAgentId)
              ) {
                if (planned) {
                  outcome.rejected.push(job);
                }
                continue;
              }
            } else if (resolveCronJobConfigRevision(job) !== change.configRevision) {
              continue;
            }
            const state: CronJobPolicyContext = {
              deps: {
                nowMs: () => policy.nowMs,
                cronConfig: policy.cronConfig,
                log: createCronMutationLogger(outcome.logs),
              },
              preparedFailureAlert: {
                jobId: job.id,
                value: resolveFailureAlert({ deps: { cronConfig: policy.cronConfig } }, job),
              },
            };
            applyJobResult(
              state,
              job,
              {
                status: "skipped",
                completionStatus: "failed",
                error:
                  change.kind === "ownerless"
                    ? CRON_AGENT_SELECTION_REQUIRED_MESSAGE
                    : change.error,
                ...(change.kind === "ownerless"
                  ? { executionStarted: false }
                  : { diagnostics: change.diagnostics }),
                startedAt: policy.nowMs,
                endedAt: policy.nowMs,
              },
              {
                deferredNotifications: outcome.notifications,
                scheduleMode: change.scheduleMode,
                ...(change.kind === "ownerless"
                  ? { scheduleOwnershipAtMs: change.scheduleOwnershipAtMs }
                  : {}),
              },
            );
            outcome.jobs.push(job);
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
    {
      operationLabel:
        change.kind === "ownerless" ? "cron.unresolved-owner" : "cron.invalid-manual-run",
    },
  );
}
