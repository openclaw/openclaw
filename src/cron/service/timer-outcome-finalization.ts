/** Finalizes receipts, runtime rows, and active markers for every cron execution. */
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { clearCronJobActive, isCronActiveJobMarkerCurrent } from "../active-jobs.js";
import {
  CronRunReceiptRevisionError,
  finishCronRunReceiptAsync,
  releaseLocalCronRunReceiptOwnership,
} from "../store/run-receipt-store.js";
import { locked } from "./locked.js";
import { clearManualCronJobActive, maybeNotifyManualIsolatedSetupTimeout } from "./ops-shared.js";
import { releaseQueuedCronRun, supersedeActivatedCronRun } from "./run-admission.js";
import { finalizeCronRuntimeRows, type CronFinalizationReceipt } from "./run-finalization.js";
import { recordQuietCronEvaluation } from "./run-history.js";
import { resolveCronRunReceiptTerminalStatus } from "./run-receipts.js";
import { applyCronRuntimeRowsToState, publishCronRuntimeRows } from "./runtime-publication.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";
import { emit, type CronServiceState } from "./state.js";
import { ensureLoaded, runPostPersistCronNotifications } from "./store.js";
import type { TimedCronRunOutcome } from "./timer-execution-timeout.js";
import {
  emitCronOutcomeEventForJob,
  emitCronOutcomeForJob,
  emitMissingRequestedCronRunTerminal,
  recordCronOutcomeForJob,
} from "./timer-outcome-events.js";
import { applyOutcomeToAuthoritativeJob, applyOutcomeToStoredJob } from "./timer-outcomes.js";

type CompletedCronRunOutcomeFinalizationOptions = {
  clearOnFailure?: boolean;
  discardWhenStopped?: boolean;
  repairFutureCronNextRunAtMs?: boolean;
  onRequestedRunFinalized?: () => void;
};

/** Coalesces terminal cron writes without holding an execution admission slot. */
export function createCompletedCronRunOutcomeDrain(
  state: CronServiceState,
  opts?: CompletedCronRunOutcomeFinalizationOptions,
) {
  const pendingOutcomes: TimedCronRunOutcome[] = [];
  const finalizedOutcomes: TimedCronRunOutcome[] = [];
  let drainPromise: Promise<void> | undefined;
  let drainFailure: { error: unknown } | undefined;

  const startDrain = () => {
    if (drainPromise || pendingOutcomes.length === 0) {
      return;
    }
    // Sibling workers can finish together; yield before snapshotting so one
    // locked reload and write settles every outcome already in the queue.
    drainPromise = Promise.resolve()
      .then(async () => {
        while (pendingOutcomes.length > 0) {
          const completed = pendingOutcomes.splice(0);
          try {
            finalizedOutcomes.push(
              ...(await finalizeCompletedCronRunOutcomes(state, completed, opts)),
            );
          } catch (error) {
            // One failed store write cannot abandon sibling outcomes: their
            // marker and reservation cleanup still belongs to this drain.
            drainFailure ??= { error };
          }
        }
      })
      .catch((error: unknown) => {
        // Keep background failures observed; the owning scheduler propagates
        // them when it joins the drain before completing its batch.
        drainFailure ??= { error };
      })
      .finally(() => {
        drainPromise = undefined;
        if (pendingOutcomes.length > 0) {
          startDrain();
        }
      });
  };

  return {
    enqueue(outcome: TimedCronRunOutcome) {
      pendingOutcomes.push(outcome);
      startDrain();
    },
    async flush(): Promise<TimedCronRunOutcome[]> {
      for (;;) {
        const pendingDrain = drainPromise;
        if (!pendingDrain) {
          break;
        }
        await pendingDrain;
      }
      if (drainFailure) {
        throw drainFailure.error;
      }
      return finalizedOutcomes.splice(0);
    },
  };
}

/** Durably finalizes finished work without waiting for unrelated cron runs. */
export async function finalizeCompletedCronRunOutcomes(
  state: CronServiceState,
  outcomes: readonly TimedCronRunOutcome[],
  opts?: CompletedCronRunOutcomeFinalizationOptions,
): Promise<TimedCronRunOutcome[]> {
  if (outcomes.length === 0) {
    return [];
  }
  for (const outcome of outcomes) {
    if (outcome.runReceipt && !outcome.runReceiptContext) {
      throw new Error("Cron finalization lost its original receipt context");
    }
  }
  const context =
    outcomes.find((outcome) => outcome.runReceiptContext)?.runReceiptContext ??
    captureOpenClawStateWorkerContext();

  let finalizedOutcomes: TimedCronRunOutcome[] = [];
  let finalizationSucceeded = false;
  const emittedRequests = new Set<TimedCronRunOutcome>();
  const missingRequestedJobs = new Set<TimedCronRunOutcome>();
  const canPublish = (outcome: TimedCronRunOutcome) =>
    !(state.stopped && opts?.discardWhenStopped) &&
    isCronActiveJobMarkerCurrent(outcome.activeJobMarker);
  try {
    await locked(state, async () => {
      await ensureLoaded(state, { forceReload: true });
      // Payload outcomes survive a failed row write as recovery facts. Quiet
      // evaluations have no payload outcome and finalize only after the commit.
      for (const outcome of outcomes) {
        if (
          outcome.request &&
          (outcome.activeJobMarker?.jobRemoved === true ||
            !state.store?.jobs.some((job) => job.id === outcome.jobId))
        ) {
          missingRequestedJobs.add(outcome);
          continue;
        }
        if (outcome.status !== "ok" || outcome.triggerEval?.fired !== false) {
          const taskJob = structuredClone(
            state.store?.jobs.find((job) => job.id === outcome.jobId) ?? outcome.job,
          );
          applyOutcomeToAuthoritativeJob(state, taskJob, outcome, {
            request: outcome.request,
            deferredNotifications: [],
          });
          await recordCronOutcomeForJob(state, taskJob, outcome);
        }
      }
      // Retirement fences publication, not the exact receipt's durable result.
      // The transaction revalidates ownership before touching authoritative rows.
      finalizedOutcomes = outcomes.filter((outcome) => outcome.runReceipt || canPublish(outcome));
      if (finalizedOutcomes.length === 0) {
        finalizationSucceeded = true;
        return;
      }

      const receipts: CronFinalizationReceipt[] = finalizedOutcomes.flatMap((outcome) =>
        outcome.runReceipt && outcome.runReceiptContext
          ? [
              {
                context: outcome.runReceiptContext,
                allowMissingJob:
                  outcome.activeJobMarker?.jobRemoved === true ||
                  !state.store?.jobs.some((job) => job.id === outcome.jobId),
                disposition: outcome.receiptSettlementDisposition,
                terminal: {
                  handle: outcome.runReceipt,
                  status: resolveCronRunReceiptTerminalStatus(
                    outcome.status,
                    outcome.triggerEval?.fired,
                  ),
                  finishedAtMs: outcome.endedAt,
                  error: outcome.error,
                },
              },
            ]
          : [],
      );
      const committedOutcomes = finalizedOutcomes;
      const committed = await finalizeCronRuntimeRows({
        state,
        context,
        receipts,
        outcomes: finalizedOutcomes.map((outcome) => {
          const {
            activeJobMarker,
            reservationIdentity: _reservationIdentity,
            runReceiptContext: _runReceiptContext,
            request,
            ...completed
          } = outcome;
          return {
            ...completed,
            activeJobMarker: activeJobMarker && {
              jobRemoved: activeJobMarker.jobRemoved,
              scheduleMutated: activeJobMarker.scheduleMutated,
              triggerMutated: activeJobMarker.triggerMutated,
            },
            request: request && {
              preserveCadence: request.preserveCadence,
              scheduleOwnershipAtMs: request.scheduleOwnershipAtMs,
            },
          };
        }),
      });
      const postPersistNotifications = committed.notifications;
      applyCronRuntimeRowsToState(
        state,
        committed.upsertedJobs,
        committed.removedJobs.map((job) => job.id),
        { publish: false },
      );
      for (const outcome of finalizedOutcomes) {
        if (outcome.status === "ok" && outcome.triggerEval?.fired === false) {
          await recordQuietCronEvaluation(state, {
            ...outcome,
            job: outcome.request?.executionJob ?? outcome.job,
          });
        }
        if (!canPublish(outcome)) {
          // Observe retired rows without publishing their schedule changes when
          // this transaction also contains a still-current sibling outcome.
          state.durableNextRunAtMsByJobId.set(
            outcome.jobId,
            state.store?.jobs.find((job) => job.id === outcome.jobId)?.state.nextRunAtMs,
          );
        }
      }
      finalizedOutcomes = finalizedOutcomes.filter(canPublish);
      finalizationSucceeded = true;
      if (finalizedOutcomes.length === 0) {
        await runPostPersistCronNotifications(state, postPersistNotifications);
        return;
      }
      const publishedJobIds = new Set(finalizedOutcomes.map((outcome) => outcome.jobId));
      for (const plan of committed.eventPlans) {
        const outcome = committedOutcomes[plan.outcomeIndex]!;
        if (!publishedJobIds.has(outcome.jobId)) {
          continue;
        }
        if (outcome.request) {
          if (plan.job && !(outcome.status === "ok" && outcome.triggerEval?.fired === false)) {
            await emitCronOutcomeForJob(state, plan.job, outcome);
            emittedRequests.add(outcome);
          }
        } else if (plan.job) {
          emitCronOutcomeEventForJob(state, plan.job, outcome);
        } else {
          await applyOutcomeToStoredJob(state, outcome, {
            deferredNotifications: postPersistNotifications,
          });
        }
      }
      await runPostPersistCronNotifications(state, postPersistNotifications);
      for (const removedJob of committed.removedJobs) {
        if (publishedJobIds.has(removedJob.id)) {
          emit(state, { jobId: removedJob.id, action: "removed", job: removedJob });
        }
      }
      publishCronRuntimeRows(state);
      try {
        const requestOutcome = finalizedOutcomes.find((outcome) => outcome.request);
        await recomputeUnownedCronSchedules(state, {
          ...(opts?.repairFutureCronNextRunAtMs === false
            ? { repairFutureCronNextRunAtMs: false }
            : {}),
          ...(requestOutcome
            ? {
                recomputeExpired: true,
                ...(requestOutcome.request?.preserveCadence
                  ? { preserveExpiredPacedNextRunJobId: requestOutcome.jobId }
                  : {}),
              }
            : {}),
        });
      } catch (error) {
        state.deps.log.warn(
          { err: String(error) },
          "cron: post-finalization schedule maintenance failed",
        );
      }
    });

    finalizationSucceeded ||= finalizedOutcomes.length > 0;
    for (const outcome of outcomes) {
      if (!outcome.request) {
        continue;
      }
      const missingJob =
        outcome.activeJobMarker?.jobRemoved === true || missingRequestedJobs.has(outcome);
      if (finalizedOutcomes.includes(outcome) && canPublish(outcome)) {
        if (!missingJob) {
          maybeNotifyManualIsolatedSetupTimeout(state, {
            jobId: outcome.jobId,
            job: outcome.request.executionJob,
            isolatedAgentSetupTimeout: outcome.isolatedAgentSetupTimeout,
          });
        }
        opts?.onRequestedRunFinalized?.();
      }
      if (!emittedRequests.has(outcome)) {
        await emitMissingRequestedCronRunTerminal(state, outcome, missingJob);
      }
    }
    return finalizedOutcomes;
  } catch (error) {
    if (error instanceof CronRunReceiptRevisionError) {
      const stale = outcomes.find((outcome) => outcome.runReceipt?.receiptId === error.receiptId);
      if (stale?.runReceipt) {
        if (!stale.runReceiptContext) {
          throw new Error("Cron supersession lost its original receipt context", { cause: error });
        }
        // A retired reservation's millisecond marker cannot identify a successor.
        // Keep its terminal fact and receipt for recovery if the guard rejects it.
        if (isCronActiveJobMarkerCurrent(stale.activeJobMarker)) {
          if (stale.reservationIdentity) {
            await supersedeActivatedCronRun({
              state,
              jobId: stale.jobId,
              reservationIdentity: stale.reservationIdentity,
              runReceipt: stale.runReceipt,
              runReceiptContext: stale.runReceiptContext,
              reason: error.message,
            });
          } else {
            await finishCronRunReceiptAsync(
              {
                handle: stale.runReceipt,
                status: "superseded",
                finishedAtMs: state.deps.nowMs(),
                error: error.message,
              },
              stale.runReceiptContext,
            );
          }
        }
        await emitMissingRequestedCronRunTerminal(state, stale);
        const remaining = outcomes.filter((outcome) => outcome !== stale);
        return await finalizeCompletedCronRunOutcomes(state, remaining, opts);
      }
    }
    throw error;
  } finally {
    for (const outcome of outcomes) {
      if (outcome.reservationIdentity) {
        releaseQueuedCronRun(state, outcome.jobId, outcome.reservationIdentity);
      }
      if (opts?.clearOnFailure !== false || finalizationSucceeded) {
        if (outcome.request) {
          clearManualCronJobActive(state, outcome.jobId, outcome.activeJobMarker);
        } else {
          clearCronJobActive(outcome.jobId, outcome.activeJobMarker);
        }
      }
      if (outcome.runReceipt) {
        releaseLocalCronRunReceiptOwnership(outcome.runReceipt);
      }
    }
  }
}
