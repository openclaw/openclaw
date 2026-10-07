import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import {
  isAgentRunDirectAbortReason,
  isAgentRunRestartAbortReason,
} from "../../agents/run-termination.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { readErrorName } from "../../infra/errors.js";

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
    return isAgentRunDirectAbortReason(error);
  }
  if (isAgentRunRestartAbortReason(signal.reason)) {
    return true;
  }
  if (readErrorName(signal.reason) === "TimeoutError") {
    return true;
  }
  if (!isGatewayAbortSignalReason(signal.reason)) {
    return false;
  }
  return isAbortError(error) || readErrorName(error) === "TimeoutError";
}

export function resolveGatewayAgentAbortStopReason(
  signal: AbortSignal,
): "restart" | "rpc" | "timeout" {
  if (isAgentRunRestartAbortReason(signal.reason)) {
    return "restart";
  }
  return readErrorName(signal.reason) === "TimeoutError" ? "timeout" : "rpc";
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
