import type { ChatEventPayload } from "./controllers/chat.ts";

type ChatEventReloadOptions = {
  activeRunId?: string | null;
};

export function shouldReloadHistoryForFinalEvent(
  payload?: ChatEventPayload,
  options?: ChatEventReloadOptions,
): boolean {
  if (!payload || payload.state !== "final") {
    return false;
  }
  if (options?.activeRunId && payload.runId === options.activeRunId) {
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
