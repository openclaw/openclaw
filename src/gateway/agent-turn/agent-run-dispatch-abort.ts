import {
  isAgentRunDirectAbortReason,
  isAgentRunRestartAbortReason,
} from "../../agents/run-termination.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { readErrorName } from "../../infra/errors.js";

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
