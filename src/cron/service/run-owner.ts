import {
  CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
  tryResolveCronJobEffectiveAgentId,
} from "../agent-id.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import type { CronRunHistorySource } from "../store/run-history.js";
import type { CronJob } from "../types.js";
import { finishCronRun } from "./run-history.js";
import { applyCronRuntimeRowsToState } from "./runtime-publication.js";
import { recordSkippedCronRuns } from "./scheduler-mutations.js";
import { emit, type CronEvent, type CronServiceState } from "./state.js";
import { captureCronServiceMutationSource, runPostPersistCronNotifications } from "./store.js";

/** Records ownerless scheduled attempts before one invalid job can block batch admission. */
export async function skipCronJobsWithoutOwners(
  state: CronServiceState,
  candidates: CronJob[],
  nowMs: number,
  opts?: {
    source?: ReturnType<typeof captureCronServiceMutationSource>;
    scheduleMode?: "advance" | "preserve";
    manualRun?: {
      runId?: string;
      commitGuard?: () => void;
      onExit?: { commitGuard: () => void };
      terminalTracker?: { emitted: boolean };
      scheduleOwnershipAtMs?: number;
    };
  },
): Promise<CronJob[]> {
  const source = opts?.source ?? captureCronServiceMutationSource(state);
  const resolveOwnerAgentId = (job: CronJob) =>
    tryResolveCronJobEffectiveAgentId(
      job,
      state.deps.resolveDefaultAgentId
        ? state.deps.resolveDefaultAgentId()
        : state.deps.defaultAgentId,
    );
  const unresolved = new Map(
    candidates.filter((job) => !resolveOwnerAgentId(job)).map((job) => [job.id, job]),
  );
  if (unresolved.size === 0) {
    return candidates;
  }
  await recordSkippedCronRuns({
    state,
    source,
    nowMs,
    change: {
      kind: "ownerless",
      proposals: [...unresolved.values()].map((job) => ({
        jobId: job.id,
        enabled: job.enabled,
        configRevision: resolveCronJobConfigRevision(job),
        nextRunAtMs: job.state.nextRunAtMs,
        lastRunAtMs: job.state.lastRunAtMs,
        lastRunStatus: job.state.lastRunStatus,
      })),
      scheduleMode: opts?.scheduleMode,
      scheduleOwnershipAtMs: opts?.manualRun?.scheduleOwnershipAtMs,
    },
    assertCurrent: () => (opts?.manualRun?.commitGuard ?? opts?.manualRun?.onExit?.commitGuard)?.(),
    async afterCommit(skipped, historySource) {
      applyCronRuntimeRowsToState(state, skipped.jobs);
      for (const entry of skipped.logs) {
        state.deps.log[entry.level](entry.fields, entry.message);
      }
      for (const job of skipped.jobs) {
        historySource.assertCurrent();
        state.deps.log.warn(
          { jobId: job.id, error: CRON_AGENT_SELECTION_REQUIRED_MESSAGE },
          "cron: skipping job with unresolved owner",
        );
        await emitOwnerlessFinished(state, job, nowMs, historySource, opts?.manualRun);
      }
      // An acknowledged manual request still gets a result when its planned row was superseded.
      if (opts?.manualRun) {
        for (const job of skipped.rejected) {
          historySource.assertCurrent();
          await emitOwnerlessFinished(state, job, nowMs, historySource, opts.manualRun);
        }
      }
      for (const notification of skipped.notifications) {
        historySource.assertCurrent();
        runPostPersistCronNotifications(state, [notification]);
      }
    },
  });
  return candidates.filter((job) => !unresolved.has(job.id));
}

async function emitOwnerlessFinished(
  state: CronServiceState,
  job: CronJob,
  nowMs: number,
  historySource: CronRunHistorySource,
  manualRun?: { runId?: string; terminalTracker?: { emitted: boolean } },
): Promise<void> {
  const event: CronEvent & { action: "finished" } = {
    jobId: job.id,
    action: "finished",
    job,
    status: "skipped",
    completionStatus: "failed",
    error: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
    runId: manualRun?.runId,
    runAtMs: nowMs,
    durationMs: 0,
    nextRunAtMs: job.state.nextRunAtMs,
    deliveryStatus: job.state.lastDeliveryStatus,
    deliveryError: job.state.lastDeliveryError,
  };
  await finishCronRun(state, { event, ownerlessRun: true, historySource });
  historySource.assertCurrent();
  emit(state, event);
  if (manualRun?.terminalTracker) {
    manualRun.terminalTracker.emitted = true;
  }
}
