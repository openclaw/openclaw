import { isDeepStrictEqual } from "node:util";
import { noteCronJobsStoreCommit } from "../store.js";
import type { CronRunHistorySource } from "../store/run-history.js";
import type { CronRuntimeMutationContracts } from "../store/runtime-mutation.types.js";
import type { CronRuntimeMutationInputs } from "../store/runtime-worker.types.js";
import { prepareCronFailureAlertPolicies } from "./failure-alerts.js";
import {
  captureCronNotificationRouting,
  prepareCronNotificationRouting,
} from "./notification-intents.js";
import { runCronRuntimeMutation } from "./runtime-mutation.js";
import { applyCronRuntimeRowsToState } from "./runtime-publication.js";
import { prepareCronScheduleOwnership } from "./schedule-maintenance.js";
import type { CronServiceState } from "./state.js";
import { captureCronServiceMutationSource, runPostPersistCronNotifications } from "./store.js";

type SchedulerSource = ReturnType<typeof captureCronServiceMutationSource>;
type SkippedOutcome = CronRuntimeMutationContracts["cron.recordSkippedRuns"]["outcome"];
type StartupOutcome = CronRuntimeMutationContracts["cron.planStartup"]["outcome"];

/** History and other effects run after the native scope joins, including a lost committed reply. */
export async function recordSkippedCronRuns(params: {
  state: CronServiceState;
  source: SchedulerSource;
  change: CronRuntimeMutationInputs["cron.recordSkippedRuns"]["change"];
  nowMs: number;
  assertCurrent?: () => void;
  afterCommit: (outcome: SkippedOutcome, historySource: CronRunHistorySource) => Promise<void>;
}): Promise<void> {
  const { state, source } = params;
  const change = structuredClone(params.change);
  let committed: SkippedOutcome | undefined;
  let historySource: CronRunHistorySource | undefined;
  let failure: { error: unknown } | undefined;
  try {
    await runCronRuntimeMutation({
      context: source.context,
      type: "cron.recordSkippedRuns",
      input: { storeKey: source.storeKey, change },
      assertCurrent() {
        source.assertCurrent();
        params.assertCurrent?.();
      },
      policy: (() => {
        const jobIds =
          change.kind === "ownerless" ? change.proposals.map(({ jobId }) => jobId) : [change.jobId];
        const alerts = prepareCronFailureAlertPolicies(state, jobIds);
        const prepared = prepareCronScheduleOwnership(state, jobIds);
        const defaultAgentId = state.deps.resolveDefaultAgentId
          ? state.deps.resolveDefaultAgentId()
          : state.deps.defaultAgentId;
        const effectiveDefaultAgentId = defaultAgentId ?? state.deps.defaultAgentId;
        const notificationRouting = captureCronNotificationRouting(
          defaultAgentId,
          state.deps.defaultAgentId,
        );
        const assertRoutingCurrent = () => {
          source.assertStorageCurrent();
          const currentDefault = state.deps.resolveDefaultAgentId
            ? state.deps.resolveDefaultAgentId()
            : state.deps.defaultAgentId;
          if (
            currentDefault !== defaultAgentId ||
            (currentDefault ?? state.deps.defaultAgentId) !== effectiveDefaultAgentId ||
            captureCronNotificationRouting(currentDefault, state.deps.defaultAgentId)
              .defaultAgentId !== notificationRouting.defaultAgentId
          ) {
            throw new Error("Cron skipped-run owner changed before completion");
          }
        };
        historySource = {
          ...source,
          defaultAgentId: effectiveDefaultAgentId,
          // A committed completion keeps its original attribution when routing refreshes.
          assertCurrent: () => source.assertStorageCurrent(),
        };
        const cronConfig = structuredClone(state.deps.cronConfig);
        return {
          value: {
            nowMs: params.nowMs,
            defaultAgentId,
            notificationRouting,
            cronConfig,
            failureAlerts: alerts.policies,
            ownership: prepared.ownership,
          },
          assertCurrent() {
            alerts.assertCurrent();
            assertRoutingCurrent();
            prepared.assertCurrent();
            if (!isDeepStrictEqual(cronConfig, state.deps.cronConfig)) {
              throw new Error("Cron skipped-run policy changed before commit");
            }
          },
        };
      })(),
      publish(outcome) {
        committed = outcome;
        if (outcome.jobs.length > 0) {
          noteCronJobsStoreCommit(source.storeKey);
        }
      },
    });
  } catch (error) {
    noteCronJobsStoreCommit(source.storeKey);
    failure = { error };
  }
  if (committed) {
    try {
      if (!historySource) {
        throw new Error("Cron skipped run lost its original history source");
      }
      historySource.assertCurrent();
      await params.afterCommit(committed, historySource);
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) {
    throw failure.error;
  }
  if (!committed) {
    throw new Error("Cron skipped run did not publish its committed outcome");
  }
}

export async function planCronStartup(params: {
  state: CronServiceState;
  source: SchedulerSource;
  nowMs: number;
  jobIds: readonly string[];
  skipJobIds?: ReadonlySet<string>;
}): Promise<StartupOutcome["missed"]> {
  const { state, source } = params;
  let committed: StartupOutcome | undefined;
  let failure: { error: unknown } | undefined;
  try {
    await runCronRuntimeMutation<"cron.planStartup">({
      context: source.context,
      type: "cron.planStartup",
      input: {
        storeKey: source.storeKey,
        jobIds: [...params.jobIds],
        skipJobIds: params.skipJobIds ? [...params.skipJobIds] : undefined,
      },
      assertCurrent: () => source.assertCurrent(),
      policy: (() => {
        const prepared = prepareCronScheduleOwnership(state, params.jobIds);
        const skipMissedJobs = state.deps.cronConfig?.skipMissedJobs === true;
        const notifications = prepareCronNotificationRouting(
          state.deps,
          skipMissedJobs,
          state.store?.jobs.filter((job) => params.jobIds.includes(job.id)),
        );
        return {
          value: {
            nowMs: params.nowMs,
            skipMissedJobs,
            ownership: prepared.ownership,
            notificationRouting: notifications.routing,
          },
          assertCurrent(outcome) {
            source.assertCurrent();
            prepared.assertCurrent();
            notifications.assertCurrent(outcome?.notifications);
            if ((state.deps.cronConfig?.skipMissedJobs === true) !== skipMissedJobs) {
              throw new Error("Cron missed-job policy changed before commit");
            }
          },
        };
      })(),
      publish(outcome) {
        committed = outcome;
        if (outcome.jobs.length > 0) {
          noteCronJobsStoreCommit(source.storeKey);
        }
      },
    });
  } catch (error) {
    noteCronJobsStoreCommit(source.storeKey);
    failure = { error };
  }
  if (committed) {
    try {
      source.assertStorageCurrent();
      for (const notification of committed.notifications) {
        source.assertStorageCurrent();
        runPostPersistCronNotifications(state, [notification]);
      }
      source.assertStorageCurrent();
      applyCronRuntimeRowsToState(state, committed.jobs);
      for (const entry of committed.logs) {
        state.deps.log[entry.level](entry.fields, entry.message);
      }
      if (committed.skippedJobIds.length > 0) {
        state.deps.log.info(
          { count: committed.skippedJobIds.length, jobIds: committed.skippedJobIds },
          "cron: skipped missed recurring jobs after restart",
        );
      }
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) {
    throw failure.error;
  }
  if (!committed) {
    throw new Error("Cron startup planning did not publish its committed outcome");
  }
  return committed.missed;
}
