import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  isCronActiveJobMarkerCurrent,
  isCronSelfRemovalCurrent,
  type CronActiveJobMarker,
} from "../active-jobs.js";
import { describeUnavailableCronAgent } from "../agent-availability.js";
import type { CronCompletionDeliveryFence } from "../delivery-attempt-fence.js";
import { parseAbsoluteTimeMs } from "../parse.js";
import { noteCronJobsStoreCommit } from "../store.js";
import { CronRunReceiptRevisionError } from "../store/run-receipt-store.js";
import type { CronRunReceiptHandle } from "../store/run-receipt.types.js";
import type { CronDeliveryAdmission, CronJob } from "../types.js";
import { hasScheduledNextRunAtMs } from "./jobs-scheduling.js";
import { runCronRuntimeMutation } from "./runtime-mutation.js";
import { applyCronRuntimeRowsToState } from "./runtime-publication.js";
import type { CronServiceState } from "./state.js";

/**
 * An immediate manual run delivers its own request, which it carries as its
 * slot. Other one-shot runs deliver the authored occurrence, including startup
 * catch-up and retry slots; recurring runs deliver their slot.
 */
function resolveCronRunOccurrenceAtMs(job: CronJob, startedAtMs: number, immediate: boolean) {
  const authoredAtMs =
    !immediate && job.schedule.kind === "at" ? parseAbsoluteTimeMs(job.schedule.at) : null;
  const slotAtMs = job.state.nextRunAtMs;
  return authoredAtMs ?? (hasScheduledNextRunAtMs(slotAtMs) ? slotAtMs : startedAtMs);
}

/** An admission recorded for another occurrence, or malformed, admits nothing for this one. */
function readAdmittedIntentId(job: CronJob, occurrenceAtMs: number): string | undefined {
  const admission: Partial<CronDeliveryAdmission> | undefined = job.state.deliveryAdmission;
  return admission?.occurrenceAtMs === occurrenceAtMs &&
    typeof admission.intentId === "string" &&
    admission.intentId
    ? admission.intentId
    : undefined;
}

export function createCronCompletionDeliveryFence(params: {
  state: CronServiceState;
  job: CronJob;
  handle: CronRunReceiptHandle;
  activeJobMarker?: CronActiveJobMarker;
  signal: AbortSignal;
  immediate: boolean;
}): CronCompletionDeliveryFence {
  const { state, handle, activeJobMarker, signal } = params;
  const context = captureOpenClawStateWorkerContext();
  const generation = state.lifecycleGeneration;
  const reservation = state.queuedRunReservationsByJobId.get(handle.jobId);
  const defaultAgentId = () => state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId;
  const admittedDefaultAgentId = defaultAgentId();
  let preparedAgentFacts: { deletionBlocked: boolean } | undefined;
  const allowMissingJob = () =>
    activeJobMarker?.jobId === handle.jobId && isCronSelfRemovalCurrent(activeJobMarker);
  const assertCurrent = () => {
    context.admission.assertCurrent();
    signal.throwIfAborted();
    if (
      preparedAgentFacts &&
      state.deps.isAgentAvailable?.(handle.agentId, undefined, preparedAgentFacts) === false
    ) {
      throw new CronRunReceiptRevisionError(
        handle.receiptId,
        describeUnavailableCronAgent(handle.agentId),
        "owner-unavailable",
      );
    }
    if (
      state.lifecycleGeneration !== generation ||
      !reservation ||
      state.queuedRunReservationsByJobId.get(handle.jobId) !== reservation ||
      reservation.runReceipt.receiptId !== handle.receiptId ||
      !isCronActiveJobMarkerCurrent(activeJobMarker) ||
      activeJobMarker?.cancellation?.kind === "requested" ||
      (activeJobMarker?.jobRemoved && !allowMissingJob()) ||
      (!params.job.agentId?.trim() && defaultAgentId() !== admittedDefaultAgentId)
    ) {
      throw new CronRunReceiptRevisionError(handle.receiptId, "cron delivery owner retired");
    }
  };
  const occurrenceAtMs = resolveCronRunOccurrenceAtMs(
    params.job,
    handle.startedAtMs,
    params.immediate,
  );
  let admittedIntentId = readAdmittedIntentId(params.job, occurrenceAtMs);
  // An immediate run admits its own intent in memory only, for its later attempts.
  let unpersistedIntentId: string | undefined;
  return {
    occurrenceAtMs,
    // Later attempts of this run read the admission as it stands, not as it began.
    get admittedIntentId() {
      return admittedIntentId ?? unpersistedIntentId;
    },
    assertCurrent,
    async beforeAttempt(admission) {
      assertCurrent();
      // An occurrence persists its first intent once. An immediate run delivers
      // its own request, which the scheduler never retries, so it never
      // displaces a scheduled occurrence whose retry may still be pending.
      const deliveryAdmission =
        admission && !params.immediate && admission.intentId !== admittedIntentId
          ? { occurrenceAtMs, intentId: admission.intentId }
          : undefined;
      let committed = false;
      try {
        await runCronRuntimeMutation({
          context,
          type: "cron.markDeliveryStarted",
          input: {
            storeKey: handle.storeKey,
            handle: { ...handle },
            ...(deliveryAdmission ? { deliveryAdmission } : {}),
          },
          assertCurrent,
          prepare(facts) {
            preparedAgentFacts = facts;
            const missingJobAllowed = allowMissingJob();
            const assertPreparedCurrent = () => {
              assertCurrent();
              if (
                facts.deletionBlocked ||
                state.deps.isAgentAvailable?.(handle.agentId, undefined, facts) === false
              ) {
                throw new CronRunReceiptRevisionError(
                  handle.receiptId,
                  describeUnavailableCronAgent(handle.agentId),
                  "owner-unavailable",
                );
              }
              if (allowMissingJob() !== missingJobAllowed) {
                throw new CronRunReceiptRevisionError(handle.receiptId);
              }
            };
            assertPreparedCurrent();
            return {
              value: { allowMissingJob: missingJobAllowed, defaultAgentId: admittedDefaultAgentId },
              assertCurrent: assertPreparedCurrent,
            };
          },
          publish(outcome) {
            committed = true;
            if (deliveryAdmission) {
              admittedIntentId = deliveryAdmission.intentId;
            }
            if (outcome.job) {
              noteCronJobsStoreCommit(handle.storeKey);
              applyCronRuntimeRowsToState(state, [outcome.job]);
            }
          },
        });
      } catch (error) {
        // A lost ordinary reply is harmless only when the matching native commit
        // already published; rollback and unknown outcomes never admit a send.
        if (!committed) {
          throw error;
        }
      }
      assertCurrent();
      if (admission && params.immediate) {
        unpersistedIntentId = admission.intentId;
      }
    },
    async releaseAdmission(intentId) {
      if (intentId === unpersistedIntentId) {
        unpersistedIntentId = undefined;
      }
      if (intentId !== admittedIntentId) {
        return;
      }
      // Abort cleanup can settle after the run finalized and lost its live
      // ownership. The stored admission and the queue's lack of custody
      // authorize the release; the worker refuses it once another run started.
      await runCronRuntimeMutation({
        context,
        type: "cron.releaseDeliveryAdmission",
        input: {
          storeKey: handle.storeKey,
          handle: { ...handle },
          admission: { occurrenceAtMs, intentId },
        },
        assertCurrent: () => {},
        prepare: () => ({ value: {}, assertCurrent: () => {} }),
        publish(outcome) {
          if (outcome.job) {
            admittedIntentId = undefined;
            noteCronJobsStoreCommit(handle.storeKey);
            applyCronRuntimeRowsToState(state, [outcome.job]);
          }
        },
      });
    },
  };
}
