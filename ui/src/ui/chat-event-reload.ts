import type { ChatEventPayload } from "./controllers/chat.ts";

export function shouldReloadHistoryForFinalEvent(
  payload?: ChatEventPayload,
  opts?: { activeRunIdBeforeEvent?: string | null },
): boolean {
  if (!payload || payload.state !== "final") {
    return false;
  }
  if (
    opts?.activeRunIdBeforeEvent &&
    payload.runId &&
    payload.runId === opts.activeRunIdBeforeEvent
  ) {
    return false;
  }
  if (!payload.message || typeof payload.message !== "object") {
    return true;
  }
  const message = payload.message as Record<string, unknown>;
  const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
  if (role && role !== "assistant") {
    return true;
  }
  return false;
}
