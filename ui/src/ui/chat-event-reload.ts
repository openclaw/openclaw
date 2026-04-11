import type { ChatEventPayload } from "./controllers/chat.ts";

type HostWithRunId = {
  chatRunId: string | null;
};

/**
 * Determine whether a chat.history reload should be triggered for a final event.
 * FIX (Bug #1): Skip reload if there's still an active chat run — the final event
 * came from a different run (e.g. sub-agent announce), and reloading during an
 * active run causes visible messages to disappear.
 */
export function shouldReloadHistoryForFinalEvent(
  payload: ChatEventPayload | undefined,
  host?: HostWithRunId,
): boolean {
  if (!payload || payload.state !== "final") {
    return false;
  }
  // If there's an active chat run, don't reload — the running agent will
  // emit its own events that update the UI incrementally.
  if (host && host.chatRunId) {
    return false;
  }
  return true;
}
