import { isSilentReplyText } from "./tokens.js";
import type { ReplyPayload } from "./types.js";

export function resolveHeartbeatReplyPayload(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload | undefined {
  if (!replyResult) {
    return undefined;
  }
  if (!Array.isArray(replyResult)) {
    return replyResult;
  }

  // Prefer an explicit trailing NO_REPLY control token over earlier narration.
  // Cron/heartbeat runs may emit helper text before tool calls and then finish
  // with NO_REPLY; selecting the last non-empty payload would leak that helper
  // text to the user-facing channel.
  for (let idx = replyResult.length - 1; idx >= 0; idx -= 1) {
    const payload = replyResult[idx];
    if (!payload || typeof payload.text !== "string") {
      continue;
    }
    if (isSilentReplyText(payload.text)) {
      return payload;
    }
  }

  for (let idx = replyResult.length - 1; idx >= 0; idx -= 1) {
    const payload = replyResult[idx];
    if (!payload) {
      continue;
    }
    if (payload.text || payload.mediaUrl || (payload.mediaUrls && payload.mediaUrls.length > 0)) {
      return payload;
    }
  }
  return undefined;
}
