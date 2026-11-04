import { resolveAgentRunAbortLifecycleFields } from "../agents/run-termination.js";

export type ChatAbortDiagnosticReason =
  | "rpc"
  | "stop"
  | "timeout"
  | "restart"
  | "archive"
  | "delete"
  | "authority-revoked"
  | "superseded"
  | "aborted";

/** Diagnostics retain owner facts without copying arbitrary abort error text. */
export function resolveChatAbortDiagnosticReason(
  signal: AbortSignal,
  entry?: { abortDiagnosticReason?: ChatAbortDiagnosticReason; abortStopReason?: string },
): ChatAbortDiagnosticReason {
  if (entry?.abortDiagnosticReason) {
    return entry.abortDiagnosticReason;
  }
  switch (entry?.abortStopReason) {
    case "rpc":
    case "stop":
    case "timeout":
    case "restart":
    case "archive":
    case "delete":
      return entry.abortStopReason;
    default:
      return resolveAgentRunAbortLifecycleFields(signal).stopReason ?? "aborted";
  }
}
