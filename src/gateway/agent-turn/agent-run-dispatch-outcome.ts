import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import {
  isAgentRunDirectAbortReason,
  resolveAgentRunErrorLifecycleFields,
} from "../../agents/run-termination.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { readErrorName } from "../../infra/errors.js";

export function projectWithdrawnAgentInput(
  payload: unknown,
  pendingInputId: string | undefined,
  stopReason?: string,
) {
  if (!pendingInputId || !isRecord(payload)) {
    return payload;
  }
  return {
    ...payload,
    ...(stopReason ? { stopReason } : {}),
    reason: "input_withdrawn_before_turn",
    pendingInputId,
    summary:
      `Input ${pendingInputId} was withdrawn before its turn started and was not delivered.` +
      ((stopReason ?? payload.stopReason) === "timeout"
        ? " Raise --timeout and retry."
        : " Resend it when ready."),
  };
}

export function resolveResolvedAgentTimeoutStopReason(
  meta: unknown,
  signal: AbortSignal,
): "timeout" | undefined {
  if (!signal.aborted) {
    return undefined;
  }
  const record = isRecord(meta) ? meta : undefined;
  if (record?.aborted !== true && record?.stopReason !== "toolUse") {
    return undefined;
  }
  return resolveGatewayAgentAbortStopReason(signal) === "timeout" ? "timeout" : undefined;
}

function isGatewayAbortSignalReason(reason: unknown): boolean {
  return reason === undefined || isAbortError(reason) || readErrorName(reason) === "TimeoutError";
}

export function isGatewayAgentAbortRejection(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) {
    // The run can cancel its own controller without aborting the Gateway observer.
    return (
      isAgentRunDirectAbortReason(error) ||
      resolveAgentRunErrorLifecycleFields(error, undefined).stopReason === "restart"
    );
  }
  if (resolveAgentRunErrorLifecycleFields(undefined, signal).stopReason === "restart") {
    return true;
  }
  if (signal.reason === "timeout" || readErrorName(signal.reason) === "TimeoutError") {
    return true;
  }
  // Public Stop routes retain these controller reasons even if the provider fails later.
  if (signal.reason === "rpc" || signal.reason === "stop") {
    return true;
  }
  if (!isGatewayAbortSignalReason(signal.reason)) {
    return false;
  }
  return isAbortError(error) || readErrorName(error) === "TimeoutError";
}

export function resolveGatewayAgentAbortStopReason(
  signal: AbortSignal,
  error?: unknown,
): "restart" | "rpc" | "timeout" {
  const stopReason = resolveAgentRunErrorLifecycleFields(error, signal).stopReason;
  return stopReason === "restart" || stopReason === "timeout" ? stopReason : "rpc";
}

// `agent` clients already consume cancellation as timeout; keep that wire
// contract while task/session projections use the canonical cancellation class.
export const RESOLVED_GATEWAY_STATUS_BY_TERMINAL_CLASSIFICATION = {
  success: "ok",
  timeout: "timeout",
  cancellation: "timeout",
  failure: "error",
} as const;

export function projectRejectedGatewayStatus(
  outcome: AgentRunTerminalOutcome,
): "error" | "timeout" {
  // The shipped wire keeps raw provider/AbortError rejections as errors. Only
  // owner-recorded cancellation/timeout metadata promotes a rejection to timeout.
  return outcome.reason === "cancelled" ||
    outcome.reason === "superseded" ||
    outcome.stopReason === "timeout"
    ? "timeout"
    : "error";
}
