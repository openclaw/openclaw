import type { Result } from "@openclaw/normalization-core/result";
import type { AgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.types.js";
import {
  isUserInitiatedAgentRunAbortReason,
  resolveAgentRunErrorLifecycleFields,
} from "../agents/run-termination.js";
import type { SessionPendingInputEndCause } from "../config/sessions/session-pending-input-end-cause.types.js";
import type { SessionPendingInputReceipt } from "../config/sessions/session-pending-input-receipt.types.js";
import {
  isOperatorAuthorityUnavailable,
  readOperatorAuthorityFailure,
} from "../infra/operator-authority-error.js";
import {
  GatewayDispatchUnavailableError,
  GatewayOperatorRecoveryAuthorizationError,
} from "../infra/restart-recovery-errors.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import type { UserTurnTranscriptRecorder } from "./user-turn-transcript.types.js";

/** Adapt the released synchronous callback only when no async companion is provided. */
export async function completeUserTurnProcessing(
  recorder: UserTurnTranscriptRecorder | undefined,
  outcome: AgentRunTerminalOutcome,
): Promise<AgentRunTerminalOutcome | undefined> {
  if (recorder?.completeProcessingAsync) {
    return await recorder.completeProcessingAsync(outcome);
  }
  if (recorder?.completeProcessing) {
    warnPluginSdkDeprecation({
      family: "session-input-completion",
      method: "UserTurnTranscriptRecorder.completeProcessing",
      replacement: "completeProcessingAsync",
    });
    return recorder.completeProcessing(outcome);
  }
  return undefined;
}
/** Explicit terminal causes win; undefined leaves a transient outage queued. */
export function resolvePendingInputEndCause(
  signal?: AbortSignal,
  failure?: unknown,
  defaultEndCause: SessionPendingInputEndCause = "failed",
): SessionPendingInputEndCause | undefined {
  const reason = resolveAgentRunErrorLifecycleFields(failure, signal).stopReason;
  if (isUserInitiatedAgentRunAbortReason(signal?.aborted ? signal.reason : failure)) {
    return "user-stop";
  }
  if (defaultEndCause === "delete" || defaultEndCause === "user-stop") {
    return defaultEndCause;
  }
  if (
    reason === "auth-revoked" ||
    failure instanceof GatewayOperatorRecoveryAuthorizationError ||
    readOperatorAuthorityFailure(failure)
  ) {
    return "revoked";
  }
  if (reason === "superseded") {
    return "reset";
  }
  if (
    isOperatorAuthorityUnavailable(failure) ||
    (failure instanceof GatewayDispatchUnavailableError && failure.retryable)
  ) {
    return undefined;
  }
  return reason === "restart" ? "restart-unrecoverable" : defaultEndCause;
}

/**
 * Accepted outages and restarts relinquish custody; pre-acceptance failures settle terminally.
 * Only the transcript commit consumes an accepted input, so an unconsumed one has not started:
 * its queued row replays after restart. A consumed one resumes from the transcript instead.
 */
export async function settleUserTurnPendingInput(
  recorder: UserTurnTranscriptRecorder | undefined,
  signal?: AbortSignal,
  failure?: unknown,
  deleted = false,
  disposition: "cancelled" | "interrupted" = "cancelled",
  accepted = false,
  explicitStop?: "user-stop",
): Promise<void> {
  const consumed = recorder?.isPendingInputConsumed?.();
  const endCause = consumed
    ? undefined
    : resolvePendingInputEndCause(signal, failure, deleted ? "delete" : explicitStop);
  try {
    if (!consumed && accepted && (endCause === undefined || endCause === "restart-unrecoverable")) {
      recorder?.relinquishPendingInput?.();
    } else if (consumed) {
      recorder?.releasePendingInput?.();
    } else {
      recorder?.finishPendingInput?.(disposition, endCause ?? "failed");
    }
  } finally {
    await recorder?.waitForPendingInputSettlement?.();
  }
}

/** The recorder owns one completion attempt, including its failure and native settlement. */
export function createUserTurnProcessingCompletion(
  readPendingInput: () => SessionPendingInputReceipt | undefined,
  sources: readonly UserTurnTranscriptRecorder[] | undefined,
  onPendingInputRelinquished: (receipt: SessionPendingInputReceipt) => void,
) {
  let processingCompletion: Result<AgentRunTerminalOutcome, unknown> | undefined;
  let processingCompletionPromise: Promise<AgentRunTerminalOutcome | undefined> | undefined;
  let relinquishedPendingInput: SessionPendingInputReceipt | undefined;
  return {
    withPendingInput: <T>(run: () => T): T => {
      const pendingInput = readPendingInput();
      return pendingInput ? pendingInput.run(run) : run();
    },
    finishPendingInput: (
      disposition: "cancelled" | "interrupted",
      endCause: SessionPendingInputEndCause,
    ) => {
      const pendingInput = readPendingInput();
      if (pendingInput) {
        pendingInput.finish(disposition, endCause);
      } else {
        for (const source of sources ?? []) {
          source.finishPendingInput?.(disposition, endCause);
        }
      }
    },
    releasePendingInput: () => {
      const pendingInput = readPendingInput();
      if (pendingInput) {
        pendingInput.release();
      } else {
        for (const source of sources ?? []) {
          source.releasePendingInput?.();
        }
      }
    },
    relinquishPendingInput: () => {
      const pendingInput = readPendingInput();
      if (pendingInput) {
        pendingInput.relinquish();
        relinquishedPendingInput = pendingInput;
      } else {
        for (const source of sources ?? []) {
          source.relinquishPendingInput?.();
        }
      }
    },
    withPendingInputCurrent: async <T>(run: () => T): Promise<Awaited<T>> => {
      const pendingInput = readPendingInput();
      return await (pendingInput?.runAsync
        ? pendingInput.runAsync(run)
        : pendingInput
          ? pendingInput.run(run)
          : run());
    },
    assertPendingInputLifetimeCurrent: () => {
      const pendingInput = readPendingInput();
      if (pendingInput?.assertLifetimeCurrent) {
        pendingInput.assertLifetimeCurrent();
      } else {
        pendingInput?.run(() => {});
      }
    },
    getProcessingCompletion: () =>
      processingCompletion?.ok ? processingCompletion.value : readPendingInput()?.completion,
    completeProcessing: (outcome: AgentRunTerminalOutcome) => {
      warnPluginSdkDeprecation({
        family: "session-input-completion",
        method: "UserTurnTranscriptRecorder.completeProcessing",
        replacement: "completeProcessingAsync",
      });
      const pendingInput = readPendingInput();
      if (!pendingInput?.complete) {
        return undefined;
      }
      if (!processingCompletion) {
        if (processingCompletionPromise) {
          throw new Error("Input completion is pending; await completeProcessingAsync");
        }
        try {
          processingCompletion = { ok: true, value: pendingInput.complete(outcome) };
        } catch (error) {
          processingCompletion = { ok: false, error };
        }
      }
      if (!processingCompletion.ok) {
        throw processingCompletion.error;
      }
      return processingCompletion.value;
    },
    completeProcessingAsync: (outcome: AgentRunTerminalOutcome) => {
      const pendingInput = readPendingInput();
      if (processingCompletionPromise) {
        return processingCompletionPromise;
      }
      processingCompletionPromise = (async () => {
        if (processingCompletion) {
          if (!processingCompletion.ok) {
            throw processingCompletion.error;
          }
          return processingCompletion.value;
        }
        if (!pendingInput?.completeAsync) {
          return undefined;
        }
        try {
          const value = await pendingInput.completeAsync(outcome);
          processingCompletion = { ok: true, value };
          return value;
        } catch (error) {
          processingCompletion = { ok: false, error };
          throw error;
        }
      })();
      return processingCompletionPromise;
    },
    waitForPendingInputSettlement: async () => {
      const relinquished = relinquishedPendingInput;
      const settled = await Promise.allSettled([
        processingCompletionPromise,
        readPendingInput()?.settled?.(),
        ...(sources ?? []).map((source) => source.waitForPendingInputSettlement?.()),
      ]);
      const failures = [
        ...new Set(
          settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        ),
      ];
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length) {
        throw new AggregateError(failures, "Failed to settle pending input custody");
      }
      if (relinquished && relinquishedPendingInput === relinquished) {
        relinquishedPendingInput = undefined;
        onPendingInputRelinquished(relinquished);
      }
    },
  };
}
