import { isSessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";

export function resolveSessionHistoryUnavailableMessage(error: unknown): string | undefined {
  if (isSessionTranscriptProjectionUnavailableError(error)) {
    return "session history is rebuilding; retry shortly";
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
