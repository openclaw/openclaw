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
  const defaultAgentId = () => state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId;
  const admittedDefaultAgentId = defaultAgentId();
  const allowMissingJob = () =>
    activeJobMarker?.jobId === handle.jobId && isCronSelfRemovalCurrent(activeJobMarker);
  const assertCurrent = () => {
    context.admission.assertCurrent();
    signal.throwIfAborted();
    if (
      state.deps.isAgentAvailable?.(handle.agentId, undefined, { deletionBlocked: false }) === false
    ) {
      throw new CronRunReceiptRevisionError(
        handle.receiptId,
        describeUnavailableCronAgent(handle.agentId),
        "owner-unavailable",
      );
    }
    if (
      state.lifecycleGeneration !== generation ||
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
          snapshot: { allowMissingJob: allowMissingJob(), defaultAgentId: admittedDefaultAgentId },
          publish() {
            committed = true;
          },
        });
      } catch (error) {
        // A lost reply does not authorize delivery; the caller may inspect the recorded outcome.
        if (!committed) {
          throw error;
        }
      }
      assertCurrent();
    },
  };
}
