import type { Result } from "@openclaw/normalization-core/result";
import type { AgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.types.js";
import type { SessionPendingInputReceipt } from "../config/sessions/session-accessor.pending-inputs.js";
import type { UserTurnTranscriptRecorder } from "./user-turn-transcript.types.js";

/** Adapt the released synchronous callback only when no async companion is provided. */
export async function completeUserTurnProcessing(
  recorder: UserTurnTranscriptRecorder | undefined,
  outcome: AgentRunTerminalOutcome,
): Promise<AgentRunTerminalOutcome | undefined> {
  return recorder?.completeProcessingAsync
    ? await recorder.completeProcessingAsync(outcome)
    : recorder?.completeProcessing?.(outcome);
}

/** The recorder owns one completion attempt, including its failure and native settlement. */
export function createUserTurnProcessingCompletion(
  readPendingInput: () => SessionPendingInputReceipt | undefined,
  sources: readonly UserTurnTranscriptRecorder[] | undefined,
) {
  let processingCompletion: Result<AgentRunTerminalOutcome, unknown> | undefined;
  let processingCompletionPromise: Promise<AgentRunTerminalOutcome | undefined> | undefined;
  return {
    getProcessingCompletion: () =>
      processingCompletion?.ok ? processingCompletion.value : readPendingInput()?.completion,
    completeProcessing: (outcome: AgentRunTerminalOutcome) => {
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
    },
  };
}
