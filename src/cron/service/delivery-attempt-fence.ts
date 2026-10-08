import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  isCronActiveJobMarkerCurrent,
  isCronSelfRemovalCurrent,
  type CronActiveJobMarker,
} from "../active-jobs.js";
import { describeUnavailableCronAgent } from "../agent-availability.js";
import type { CronCompletionDeliveryFence } from "../delivery-attempt-fence.js";
import { CronRunReceiptRevisionError } from "../store/run-receipt-store.js";
import type { CronRunReceiptHandle } from "../store/run-receipt.types.js";
import type { CronJob } from "../types.js";
import { runCronRuntimeMutation } from "./runtime-mutation.js";
import type { CronServiceState } from "./state.js";

export function createCronCompletionDeliveryFence(params: {
  state: CronServiceState;
  job: CronJob;
  handle: CronRunReceiptHandle;
  activeJobMarker?: CronActiveJobMarker;
  signal: AbortSignal;
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
  return {
    assertCurrent,
    async beforeAttempt() {
      assertCurrent();
      let committed = false;
      try {
        await runCronRuntimeMutation({
          context,
          type: "cron.markDeliveryStarted",
          input: { storeKey: handle.storeKey, handle: { ...handle } },
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
          publish() {
            committed = true;
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
    },
  };
}
