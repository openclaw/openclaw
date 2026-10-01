import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
  CRON_LEGACY_OWNER_REPAIR_REQUIRED_MESSAGE,
  tryResolveCronJobEffectiveAgentId,
} from "../agent-id.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import {
  DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  hasActiveCronRun,
  isJobEnabled,
  recomputeJobNextRunAtMs,
  resolveJobErrorBackoffUntilMs,
} from "../service/jobs-scheduling.js";
import { resolveCronNotificationQueueOwner } from "../service/notification-intents.js";
import type { CronJobPolicyContext } from "../service/state.js";
import { applyJobResult } from "../service/timer-outcomes.js";
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
          const preparation = prepareCronRuntimeMutation("cron.recordSkippedRuns", input.nonce, {
            jobs: [...jobs.values()].map(({ id, delivery, failureAlert }) => ({
              id,
              delivery,
              failureAlert,
            })),
          });
          const outcome: CronRuntimeMutationContracts["cron.recordSkippedRuns"]["outcome"] = {
            jobs: [],
            rejected: [],
            nowMs: preparation.nowMs,
            notifications: [],
            logs: [],
          };
          if (change.kind === "ownerless" && preparation.legacyDefaultAgentId) {
            throw new Error(CRON_LEGACY_OWNER_REPAIR_REQUIRED_MESSAGE);
          }
          const ownership = new Map(preparation.ownership.map((owner) => [owner.jobId, owner]));
          const failureAlerts = new Map(
            preparation.failureAlerts.map((alert) => [alert.jobId, alert]),
          );
          for (const job of jobs.values()) {
            if (change.kind === "ownerless") {
              const planned = proposals.get(job.id);
              const owner = ownership.get(job.id);
              if (!owner) {
                throw new Error("Cron ownerless skip has no prepared process ownership");
              }
              if (
                !planned ||
                job.enabled !== planned.enabled ||
                job.state.nextRunAtMs !== planned.nextRunAtMs ||
                job.state.lastRunAtMs !== planned.lastRunAtMs ||
                job.state.lastRunStatus !== planned.lastRunStatus ||
                resolveCronJobConfigRevision(job) !== planned.configRevision ||
                hasActiveCronRun(job, owner.active) ||
                findActiveCronRunReceiptInDatabase({
                  database: db,
                  storePath: input.storeKey,
                  jobId: job.id,
                }) ||
                tryResolveCronJobEffectiveAgentId(
                  job,
                  preparation.defaultAgentId,
                  preparation.legacyDefaultAgentId,
                )
              ) {
                if (planned) {
                  outcome.rejected.push(job);
                }
                continue;
              }
            } else if (resolveCronJobConfigRevision(job) !== change.configRevision) {
              continue;
            }
            const failureAlert = failureAlerts.get(job.id);
            if (!failureAlert) {
              throw new Error("Cron skipped run has no prepared failure-alert policy");
            }
            const state: CronJobPolicyContext = {
              deps: {
                nowMs: () => preparation.nowMs,
                cronConfig: preparation.cronConfig,
                log: createCronMutationLogger(outcome.logs),
              },
              preparedFailureAlert: { jobId: job.id, value: failureAlert.value },
            };
            applyJobResult(
              state,
              job,
              {
                status: "skipped",
                completionStatus: "failed",
                error:
                  change.kind === "ownerless"
                    ? preparation.legacyDefaultAgentId
                      ? CRON_LEGACY_OWNER_REPAIR_REQUIRED_MESSAGE
                      : CRON_AGENT_SELECTION_REQUIRED_MESSAGE
                    : change.error,
                ...(change.kind === "ownerless"
                  ? { executionStarted: false }
                  : { diagnostics: change.diagnostics }),
                startedAt: preparation.nowMs,
                endedAt: preparation.nowMs,
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
            notification.routing = preparation.notificationRouting;
          }
          return { upsertJobIds: outcome.jobs.map((job) => job.id), value: outcome };
        },
      });
      return retainCronRuntimeMutationOutcome(
        "cron.recordSkippedRuns",
        db,
        input.nonce,
        committed.value,
      );
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    {
      operationLabel:
        change.kind === "ownerless" ? "cron.unresolved-owner" : "cron.invalid-manual-run",
    },
  );
}

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
