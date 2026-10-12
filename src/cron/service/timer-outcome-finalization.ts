import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import { clearCronJobActive, isCronActiveJobMarkerCurrent } from "../active-jobs.js";
import { noteCronJobsStoreCommit } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { cronRunResultEvent } from "../store/run-result.js";
import { needsCronTimerMaintenance } from "./jobs-scheduling.js";
import { locked } from "./locked.js";
import { clearManualCronJobActive, maybeNotifyManualIsolatedSetupTimeout } from "./ops-shared.js";
import {
  applyCronRuntimeRowsToState,
  publishDurableNextRunChanges,
} from "./runtime-publication.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";
import { cronFailureNotificationEventContext, emit, type CronServiceState } from "./state.js";
import { ensureLoaded, runPostPersistCronNotifications } from "./store.js";
import type { TimedCronRunOutcome } from "./timer-execution-timeout.js";

type CompletedCronRunOutcomeFinalizationOptions = {
  clearOnFailure?: boolean;
  discardWhenStopped?: boolean;
  repairFutureCronNextRunAtMs?: boolean;
  onRequestedRunFinalized?: () => void;
};

/** Sends terminal facts to the worker; the host only publishes committed results. */
export async function finalizeCompletedCronRunOutcomes(
  state: CronServiceState,
  outcomes: readonly TimedCronRunOutcome[],
  opts?: CompletedCronRunOutcomeFinalizationOptions,
): Promise<TimedCronRunOutcome[]> {
  if (!outcomes.length) {
    return [];
  }
  const context =
    outcomes.find((outcome) => outcome.runReceiptContext)?.runReceiptContext ??
    captureOpenClawStateWorkerContext();
  const storeKey = cronStoreKey(state.deps.storePath);
  const canPublish = (outcome: TimedCronRunOutcome) =>
    !(state.stopped && opts?.discardWhenStopped) &&
    isCronActiveJobMarkerCurrent(outcome.activeJobMarker);
  const finalized: TimedCronRunOutcome[] = [];
  let committedSuccessfully = false;
  try {
    const committed = await locked(state, async () => {
      await ensureLoaded(state, { forceReload: true });
      const { outcome: result } = await executeOpenClawStateWorker(context, {
        type: "cron.finalizeRuns",
        input: {
          storeKey,
          snapshot: {
            nowMs: state.deps.nowMs(),
            defaultAgentId: state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId,
            cronConfig: state.deps.cronConfig,
            outcomes: outcomes.map(
              ({ activeJobMarker, runReceiptContext: _context, request, ...completed }) => ({
                ...completed,
                activeJobMarker: activeJobMarker && {
                  jobRemoved: activeJobMarker.jobRemoved,
                  scheduleMutated: activeJobMarker.scheduleMutated,
                  triggerMutated: activeJobMarker.triggerMutated,
                },
                request: request && {
                  preserveCadence: request.preserveCadence,
                  onExitWatcherCompletion: request.onExitWatcherCompletion,
                  scheduleOwnershipAtMs: request.scheduleOwnershipAtMs,
                  runId: request.runId,
                },
              }),
            ),
          },
        },
      });
      committedSuccessfully = true;
      if (result.changed) {
        noteCronJobsStoreCommit(storeKey);
      }
      applyCronRuntimeRowsToState(
        state,
        result.upsertedJobs,
        result.removedJobs.map((job) => job.id),
        { publish: false },
      );
      for (const entry of result.logs) {
        state.deps.log[entry.level](entry.fields, entry.message);
      }
      for (const plan of result.eventPlans) {
        const outcome = outcomes[plan.outcomeIndex]!;
        if (!canPublish(outcome)) {
          continue;
        }
        finalized.push(outcome);
        if (
          !(outcome.status === "ok" && outcome.triggerEval?.fired === false) ||
          outcome.request?.runId
        ) {
          emit(
            state,
            cronRunResultEvent(plan.job, outcome),
            cronFailureNotificationEventContext(outcome.failureNotificationDetail),
          );
          if (outcome.request?.terminalTracker) {
            outcome.request.terminalTracker.emitted = true;
          }
        }
        if (outcome.request) {
          maybeNotifyManualIsolatedSetupTimeout(state, {
            jobId: outcome.jobId,
            job: outcome.request.executionJob,
            isolatedAgentSetupTimeout: outcome.isolatedAgentSetupTimeout,
          });
          opts?.onRequestedRunFinalized?.();
        }
      }
      for (const job of result.removedJobs) {
        if (finalized.some((outcome) => outcome.jobId === job.id)) {
          emit(state, { jobId: job.id, action: "removed", job });
        }
      }
      publishDurableNextRunChanges({ state, storeJobs: state.store?.jobs ?? [] });
      return result;
    });
    // Notification failures cannot hold the writer or undo terminal accounting.
    void runPostPersistCronNotifications(state, committed.notifications).catch((error: unknown) => {
      state.deps.log.warn({ err: String(error) }, "cron: post-run notification failed");
    });
    if (finalized.length) {
      try {
        const request = finalized.find((outcome) => outcome.request);
        const nowMs = state.deps.nowMs();
        if (request || state.store?.jobs.some((job) => needsCronTimerMaintenance(job, nowMs))) {
          await locked(state, () =>
            recomputeUnownedCronSchedules(state, {
              nowMs,
              repairFutureCronNextRunAtMs: opts?.repairFutureCronNextRunAtMs,
              ...(request
                ? {
                    recomputeExpired: true,
                    ...(request.request?.preserveCadence
                      ? { preserveExpiredPacedNextRunJobId: request.jobId }
                      : {}),
                  }
                : {}),
            }),
          );
        }
      } catch (error) {
        state.deps.log.warn(
          { err: String(error) },
          "cron: post-finalization schedule maintenance failed",
        );
      }
    }
    return finalized;
  } finally {
    if (!committedSuccessfully) {
      // A lost reply may hide a committed result. Refresh views without replaying the run.
      noteCronJobsStoreCommit(storeKey);
    }
    for (const outcome of outcomes) {
      if (opts?.clearOnFailure !== false || committedSuccessfully) {
        if (outcome.request) {
          clearManualCronJobActive(state, outcome.jobId, outcome.activeJobMarker);
        } else {
          clearCronJobActive(outcome.jobId, outcome.activeJobMarker);
        }
      }
    }
  }
}
