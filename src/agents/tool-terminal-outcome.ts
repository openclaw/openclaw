import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  prepareDispatchArguments,
  readDispatchCall,
} from "../../packages/agent-core/src/dispatch-call.js";
import {
  consumeTrackedToolExecutionStarted,
  peekAdjustedParamsForToolCall,
  peekPreExecutionBlockedToolCall,
} from "./agent-tools.before-tool-call.state.js";
import { projectPluginMessageDeliveryFact } from "./embedded-agent-message-delivery.js";
import type { EmbeddedRunAttemptParams } from "./embedded-agent-runner/run/types.js";
import { isToolCallDispatcherName } from "./tool-display-call.js";
import { buildToolEffectReceipt, readToolEffectReceipt } from "./tool-effect-receipt.js";
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
  let lastToolError: ToolErrorSummary | undefined;
  // The catalog target a failed dispatch named; unset when the catalog resolved no target.
  let failedDispatchTarget: string | undefined;

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
    const details = readToolResultDetails(observation.result);
    // Steering skips and handled message omissions neither fail nor recover earlier work.
    const preservesFailure =
      (!executionStarted && details?.status === "skipped" && details.deniedReason === "steering") ||
      (observation.outcome !== "failure" &&
        observation.toolName === "message" &&
        projectPluginMessageDeliveryFact(observation.result)?.status === "suppressed");
    // Read the target with the dispatcher's own reader, so recovery and the repeat guard agree.
    // The dispatcher reports the catalog tool it resolved; a call without one named no tool.
    const dispatchCall = isToolCallDispatcherName(observation.toolName)
      ? readDispatchCall(prepareDispatchArguments(executedArguments))
      : undefined;
    const dispatchedId = dispatchCall && !("error" in dispatchCall) ? dispatchCall.id : undefined;
    const catalogTool = dispatchCall ? asRecord(details?.tool) : undefined;
    const catalogId = typeof catalogTool?.id === "string" ? catalogTool.id : undefined;
    const catalogName = typeof catalogTool?.name === "string" ? catalogTool.name : undefined;
    if (!preservesFailure && observation.outcome === "failure") {
      const mutatingAction = executionStarted && mutation.mutatingAction;
      const terminalDiagnostic =
        observation.failure?.terminalDiagnostic ??
        (executionStarted ? readTimeoutDiagnostic(observation.result) : undefined);
      const dispatchedToolName = catalogName ?? dispatchedId;
      failedDispatchTarget = catalogId ? dispatchedId : undefined;
      lastToolError = {
        toolName: observation.toolName,
        ...(dispatchedToolName && dispatchedToolName !== observation.toolName
          ? { dispatchedToolName }
          : {}),
        ...(observation.meta ? { meta: observation.meta } : {}),
        ...observation.failure,
        ...(terminalDiagnostic ? { terminalDiagnostic } : {}),
        executionStarted,
        mutatingAction,
      };
    } else if (
      !preservesFailure &&
      lastToolError &&
      // A call to a missing tool did nothing and has no name a retry could reuse, so the
      // next successful executed call recovers it. A dispatch recovers by its catalog target;
      // one the catalog could not resolve has no target to retry, so any later dispatch
      // recovers it. Otherwise only the same tool recovers.
      (lastToolError.unknownTool
        ? executionStarted
        : isToolCallDispatcherName(lastToolError.toolName)
          ? dispatchCall !== undefined &&
            (failedDispatchTarget === undefined ||
              [dispatchedId, catalogId, catalogName].includes(failedDispatchTarget))
          : normalizeLowercaseStringOrEmpty(lastToolError.toolName) ===
            normalizeLowercaseStringOrEmpty(observation.toolName))
    ) {
      lastToolError = undefined;
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
