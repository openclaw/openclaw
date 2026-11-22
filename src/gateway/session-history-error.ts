import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { isSessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";

export function resolveSessionHistoryUnavailableMessage(error: unknown): string | undefined {
  if (isSessionTranscriptProjectionUnavailableError(error)) {
    return error.reason === "window-changed"
      ? "session history window changed; reload the conversation"
      : "session history is rebuilding; retry shortly";
  }
  if (!(error instanceof WorkerTaskError)) {
    return undefined;
  }
  switch (error.code) {
    case "overloaded":
      return "session history is busy; retry shortly";
    case "unavailable":
      return "session history is temporarily unavailable; retry shortly";
    case "timeout":
      return "session history read timed out; retry shortly";
    default:
      return undefined;
  }
}

export type ChatHistoryMethod =
  | "chat.history"
  | "chat.startup"
  | "chat.message.get"
  | "chat.predict"
  | "chat.pendingInputs.dismiss";

export function chatHistoryUnavailableError(method: ChatHistoryMethod, message: string) {
  return errorShape(ErrorCodes.UNAVAILABLE, message, {
    details: { method },
    retryable: true,
    retryAfterMs: 250,
  });
}
