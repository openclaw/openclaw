import type { ChatEventPayload } from "./controllers/chat.ts";

export function shouldReloadHistoryForFinalEvent(
  payload?: ChatEventPayload,
  runHasMedia?: boolean,
): boolean {
  if (!payload || payload.state !== "final") {
    return false;
  }
  // Reload when the run produced renderable media.  Server-side
  // injectMediaImagesIntoHistory resolves MEDIA: file paths to inline base64
  // — this transform only exists in chat.history, so a reload is needed.
  if (runHasMedia) {
    return true;
  }
  // Reload when the final has no usable assistant message (e.g. cross-run
  // finals from sub-agents) — the actual content must be fetched from history.
  if (!payload.message || typeof payload.message !== "object") {
    return true;
  }
  const message = payload.message as Record<string, unknown>;
  const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
  if (role && role !== "assistant") {
    return true;
  }
  // Same-run final with assistant message: already appended locally, no reload.
  return false;
}
