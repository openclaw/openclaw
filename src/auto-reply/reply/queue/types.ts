import type { MediaImageLayout } from "../../../agents/embedded-agent-runner/run/prompt-image-metadata.js";
import type {
  FollowupRun,
  ReplyOperationRunState,
} from "../../../sessions/session-controller.contracts.js";

export type { FollowupRun } from "../../../sessions/session-controller.contracts.js";
export type {
  QueuedFollowupReplyBatch,
  QueuedFollowupReplyDelivery,
} from "./followup-run-payload.types.js";
export type {
  QueueDropPolicy,
  QueueSettings,
  ResolveQueueSettingsParams,
  QueueDedupeMode,
  EnqueueFollowupRunOptions,
} from "./queue-settings.types.js";

export class FollowupRunDeferredError extends Error {
  constructor(message = "Follow-up run deferred") {
    super(message);
    this.name = "FollowupRunDeferredError";
  }
}

export function bindReplyOperationQueueDisposition(
  run: Pick<FollowupRun, "onQueueDisposition">,
  state: ReplyOperationRunState | undefined,
): void {
  const observe = run.onQueueDisposition;
  run.onQueueDisposition = (disposition) => {
    observe?.(disposition);
    if (state && (disposition !== "queue-cap-old" || state.admission?.status !== "accepted")) {
      state.admission = { status: "skipped", reason: "queue-cap" };
    }
  };
}

/** Admission-owned image facts stay out of the public FollowupRun contract. */
export type InternalFollowupRun = FollowupRun & {
  currentTurnImagesPrepared?: true;
  /** Fact indexes are relative to this run's media array. */
  mediaImageLayout?: MediaImageLayout;
};

export function isFollowupRunAborted(
  run: Pick<
    FollowupRun,
    "abortSignal" | "queueAbortSignal" | "operatorAuthority" | "controllerInput"
  >,
): boolean {
  return (
    (!run.controllerInput?.custody.cancellationRetired &&
      (run.abortSignal?.aborted === true || run.controllerInput?.abortSignal.aborted === true)) ||
    run.queueAbortSignal?.aborted === true ||
    run.operatorAuthority?.signal?.aborted === true
  );
}

export function resolveFollowupAbortSignal(
  run: Pick<
    FollowupRun,
    "abortSignal" | "queueAbortSignal" | "operatorAuthority" | "controllerInput"
  >,
): AbortSignal | undefined {
  const signals = [
    run.controllerInput?.custody.cancellationRetired ? undefined : run.abortSignal,
    run.controllerInput?.custody.cancellationRetired ? undefined : run.controllerInput?.abortSignal,
    run.queueAbortSignal,
    run.operatorAuthority?.signal,
  ].filter((signal): signal is AbortSignal => signal !== undefined);
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}
