import type { ChatEventPayload } from "./controllers/chat.ts";

type FinalEventReloadOptions = {
  trackedRunId?: string | null;
};

export function shouldReloadHistoryForFinalEvent(
  payload?: ChatEventPayload,
  options?: FinalEventReloadOptions,
): boolean {
  if (!payload || payload.state !== "final") {
    return false;
  }
  const trackedRunId = options?.trackedRunId?.trim();
  if (trackedRunId && (!payload.runId || payload.runId === trackedRunId)) {
    return false;
  }
  return true;
}
