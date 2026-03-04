import type { ChatEventPayload } from "./controllers/chat.ts";

export function shouldReloadHistoryForFinalEvent(payload?: ChatEventPayload): boolean {
  // Also reload for delta (streaming) events - ensures TUI displays content even without <final> tag
  // This fixes regression where model outputs with thinking don't show in TUI
  if (!payload || (payload.state !== "final" && payload.state !== "delta")) {
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
