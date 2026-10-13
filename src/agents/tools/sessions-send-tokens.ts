import { HEARTBEAT_TOKEN, isSilentReplyText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";

const NON_DELIVERABLE_REPLY_TOKENS = [SILENT_REPLY_TOKEN, HEARTBEAT_TOKEN] as const;

export function isNonDeliverableSessionsReply(text?: string) {
  return NON_DELIVERABLE_REPLY_TOKENS.some((token) => isSilentReplyText(text, token));
}

/** Selects a deliverable reply while allowing NO_REPLY to use captured fallback output. */
export function selectDeliverableSessionsReply(
  primary?: string | null,
  fallback?: string | null,
): string | undefined {
  const primaryReply = primary?.trim();
  if (primaryReply && !isNonDeliverableSessionsReply(primaryReply)) {
    return primaryReply;
  }
  if (primaryReply && !isSilentReplyText(primaryReply, SILENT_REPLY_TOKEN)) {
    return undefined;
  }
  const fallbackReply = fallback?.trim();
  return fallbackReply && !isNonDeliverableSessionsReply(fallbackReply) ? fallbackReply : undefined;
}
