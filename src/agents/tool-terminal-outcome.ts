import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  consumeTrackedToolExecutionStarted,
  peekAdjustedParamsForToolCall,
  peekPreExecutionBlockedToolCall,
} from "./agent-tools.before-tool-call.state.js";
import { projectPluginMessageDeliveryFact } from "./embedded-agent-message-delivery.js";
import type { EmbeddedRunAttemptParams } from "./embedded-agent-runner/run/types.js";
import { buildToolEffectReceipt, readToolEffectReceipt } from "./tool-effect-receipt.js";
import { createToolErrorState } from "./tool-error-state.js";
import type { ToolErrorSummary } from "./tool-error-summary.js";
import { buildToolMutationState } from "./tool-mutation.js";
import { readToolResultDetails } from "./tool-result-error.js";

function readTimeoutDiagnostic(result: unknown): ToolErrorSummary["terminalDiagnostic"] {
  const details = readToolResultDetails(result);
  const timeoutMs = details?.timeoutMs;
  if (
    details?.timedOut !== true ||
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return undefined;
  }
  return {
    kind: "timeout",
    timeoutMs,
    ...(details.partial === true && Array.isArray(details.results) && details.results.length > 0
      ? { partialResults: details.results.length }
      : {}),
  };
}

/** Build one attempt-scoped facts-in/state-out terminal observer for every harness. */
export function createToolTerminalObserver(
  runId: string,
): NonNullable<EmbeddedRunAttemptParams["observeToolTerminal"]> {
  const errors = createToolErrorState();

  return (observation) => {
    const effectReceipt = readToolEffectReceipt(observation.result);
    const trackedExecutionStarted = observation.toolCallId
      ? consumeTrackedToolExecutionStarted(observation.toolCallId, runId)
      : undefined;
    const trackedArguments = observation.toolCallId
      ? peekAdjustedParamsForToolCall(observation.toolCallId, runId)
      : undefined;
    const executionPrevented = observation.toolCallId
      ? peekPreExecutionBlockedToolCall(observation.toolCallId, runId)
      : false;
    const executionStarted =
      (trackedExecutionStarted ?? observation.executionStarted ?? true) &&
      !executionPrevented &&
      effectReceipt?.state !== "not_started";
    const executedArguments = asRecord(trackedArguments) ?? asRecord(observation.arguments);
    const mutation = observation.ownerMutation
      ? buildToolMutationState(observation.toolName, executedArguments, {
          ownerKey: observation.ownerMutation.ownerKey,
        })
      : (observation.nativeMutation ??
        buildToolMutationState(observation.toolName, executedArguments));
    const replaySafe = observation.replaySafe ?? mutation.replaySafe;
    let lastToolError: ToolErrorSummary | undefined;
    if (observation.outcome === "failure") {
      const mutatingAction = executionStarted && mutation.mutatingAction;
      const terminalDiagnostic =
        observation.failure?.terminalDiagnostic ??
        (executionStarted ? readTimeoutDiagnostic(observation.result) : undefined);
      const failure: ToolErrorSummary = {
        toolName: observation.toolName,
        ...(observation.meta ? { meta: observation.meta } : {}),
        ...observation.failure,
        ...(terminalDiagnostic ? { terminalDiagnostic } : {}),
        executionStarted,
        mutatingAction,
      };
      lastToolError = errors.recordFailure(failure).lastToolError;
    } else if (
      observation.toolName === "message" &&
      projectPluginMessageDeliveryFact(observation.result)?.status === "suppressed"
    ) {
      // A handled omission does not recover an earlier failed delivery.
      lastToolError = errors.read().lastToolError;
    } else {
      lastToolError = errors.recordSuccess(observation.toolName).lastToolError;
    }

    return {
      ...(lastToolError ? { lastToolError } : {}),
      executionStarted,
      ...(executedArguments ? { executedArguments } : {}),
      sideEffectEvidence: executionStarted && !replaySafe,
      effectReceipt:
        effectReceipt ??
        buildToolEffectReceipt({
          executionStarted,
          mutatingAction: mutation.mutatingAction,
          replaySafe,
          outcome: observation.outcome,
        }),
    };
  };
}
