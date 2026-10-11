import { noteCronJobsStoreCommit } from "../store.js";
import type { CronRunHistorySource } from "../store/run-history.js";
import type {
  CronRuntimeMutationContracts,
  CronRuntimeMutationInputs,
} from "../store/runtime-worker.types.js";
import { hasActiveCronRun, isJobEnabled } from "./jobs-scheduling.js";
import {
  captureCronNotificationRouting,
  resolveCronNotificationQueueOwner,
} from "./notification-intents.js";
import { runCronRuntimeMutation } from "./runtime-mutation.js";
import { applyCronRuntimeRowsToState } from "./runtime-publication.js";
import { captureCronScheduleOwnership } from "./schedule-maintenance.js";
import type { CronServiceState } from "./state.js";
import { captureCronServiceMutationSource, runPostPersistCronNotifications } from "./store.js";

type SchedulerSource = ReturnType<typeof captureCronServiceMutationSource>;
type SkippedOutcome = CronRuntimeMutationContracts["cron.recordSkippedRuns"]["outcome"];
type StartupOutcome = CronRuntimeMutationContracts["cron.planStartup"]["outcome"];

/** Publish history and other effects after the worker transaction completes. */
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
  const defaultAgentId = state.deps.resolveDefaultAgentId
    ? state.deps.resolveDefaultAgentId()
    : state.deps.defaultAgentId;
  const historySource: CronRunHistorySource = {
    ...source,
    defaultAgentId: defaultAgentId ?? state.deps.defaultAgentId,
    // A committed completion keeps its original attribution when routing refreshes.
    assertCurrent: () => source.assertStorageCurrent(),
  };
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
      // Routing and activity may change after submission; this snapshot owns the outcome.
      snapshot: {
        nowMs: params.nowMs,
        defaultAgentId,
        notificationRouting: captureCronNotificationRouting(
          defaultAgentId,
          state.deps.defaultAgentId,
        ),
        cronConfig: structuredClone(state.deps.cronConfig),
        ownership: captureCronScheduleOwnership(
          state,
          state.store?.jobs.map((job) => job.id) ?? [],
        ),
      },
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
  const skipMissedJobs = state.deps.cronConfig?.skipMissedJobs === true;
  const selected = new Set(params.jobIds);
  const notificationNeedsDefault =
    skipMissedJobs &&
    state.store?.jobs.some(
      (job) =>
        selected.has(job.id) &&
        isJobEnabled(job) &&
        !params.skipJobIds?.has(job.id) &&
        !hasActiveCronRun(job, false) &&
        (job.schedule.kind === "cron" || job.schedule.kind === "every") &&
        !resolveCronNotificationQueueOwner(job, "auto-disabled").agentId,
    );
  let committed: StartupOutcome | undefined;
  let failure: { error: unknown } | undefined;
  try {
    await runCronRuntimeMutation({
      context: source.context,
      type: "cron.planStartup",
      input: {
        storeKey: source.storeKey,
        jobIds: [...params.jobIds],
        skipJobIds: params.skipJobIds ? [...params.skipJobIds] : undefined,
      },
      assertCurrent: () => source.assertCurrent(),
      // A reload may race planning; queued effects retain this routing snapshot.
      snapshot: {
        nowMs: params.nowMs,
        skipMissedJobs,
        ownership: captureCronScheduleOwnership(state, params.jobIds),
        notificationRouting: captureCronNotificationRouting(
          notificationNeedsDefault ? state.deps.resolveDefaultAgentId?.() : undefined,
          notificationNeedsDefault ? state.deps.defaultAgentId : undefined,
        ),
      },
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
        await runPostPersistCronNotifications(state, [notification]);
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
