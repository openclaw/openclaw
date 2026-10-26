import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import { clearCronJobActive, isCronActiveJobMarkerCurrent } from "../active-jobs.js";
import { getCronJobsStoreRevision, noteCronJobsStoreCommit } from "../store.js";
import { cronRunResultEvent } from "../store/run-result.js";
import { isDeferredCronAdmission } from "./admission-deferred.js";
import { needsCronTimerMaintenance } from "./jobs-scheduling.js";
import { locked } from "./locked.js";
import { clearManualCronJobActive, maybeNotifyManualIsolatedSetupTimeout } from "./ops-shared.js";
import {
  applyCronRuntimeRowsToState,
  publishDurableNextRunChanges,
} from "./runtime-publication.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";
import { cronFailureNotificationEventContext, emit, type CronServiceState } from "./state.js";
import {
  ensureLoaded,
  noteLoadedCronStoreCommit,
  runPostPersistCronNotifications,
} from "./store.js";
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
  if (
    outcomes.length > 1 &&
    outcomes.some((outcome) => isDeferredCronAdmission(outcome.job, outcome))
  ) {
    const completed = outcomes.filter((outcome) => !isDeferredCronAdmission(outcome.job, outcome));
    const deferred = outcomes.filter((outcome) => isDeferredCronAdmission(outcome.job, outcome));
    const finalized: TimedCronRunOutcome[] = [];
    const failures: unknown[] = [];
    // Completed siblings survive a failed deferred-admission transition.
    for (const batch of [completed, ...deferred.map((outcome) => [outcome])]) {
      try {
        finalized.push(...(await finalizeCompletedCronRunOutcomes(state, batch, opts)));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Cron outcome settlement failed");
    }
    return finalized;
  }
  const context =
    outcomes.find((outcome) => outcome.runReceiptContext)?.runReceiptContext ??
    captureOpenClawStateWorkerContext();
  const storeKey = state.deps.storeKey;
  const canPublish = (outcome: TimedCronRunOutcome) =>
    !(state.stopped && opts?.discardWhenStopped) &&
    isCronActiveJobMarkerCurrent(outcome.activeJobMarker);
  const finalized: TimedCronRunOutcome[] = [];
  let committedSuccessfully = false;
  try {
    const committed = await locked(state, async () => {
      if (!state.store) {
        await ensureLoaded(state);
      }
      const observedRevision = getCronJobsStoreRevision(storeKey);
      const { outcome: result } = await executeOpenClawStateWorker(context, {
        type: "cron.finalizeRuns",
        input: {
          storeKey,
          snapshot: {
            nowMs: state.deps.nowMs(),
            defaultAgentId: state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId,
            cronConfig: state.deps.cronConfig,
            failureRepairTimeoutMs: state.deps.failureRepairTimeoutMs,
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
      applyCronRuntimeRowsToState(
        state,
        result.upsertedJobs,
        result.removedJobs.map((job) => job.id),
        { publish: false },
      );
      if (result.changed) {
        noteLoadedCronStoreCommit(state, observedRevision);
      }
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
