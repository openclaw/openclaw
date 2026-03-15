import { isSilentReplyText } from "./tokens.js";
import type { ReplyPayload } from "./types.js";

function hasMedia(payload: ReplyPayload): boolean {
  return Boolean(payload.mediaUrl || (payload.mediaUrls && payload.mediaUrls.length > 0));
}

export function resolveHeartbeatReplyPayload(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload | undefined {
  if (!replyResult) {
    return undefined;
  }

  if (!Array.isArray(replyResult)) {
    if (hasMedia(replyResult)) {
      return replyResult;
    }
    if (replyResult.text && isSilentReplyText(replyResult.text)) {
      return undefined;
    }
    return replyResult.text ? replyResult : undefined;
  }

  for (let idx = replyResult.length - 1; idx >= 0; idx -= 1) {
    const payload = replyResult[idx];
    if (!payload) {
      continue;
    }

    if (hasMedia(payload)) {
      return payload;
    }

    if (!payload.text) {
      continue;
    }

    if (isSilentReplyText(payload.text)) {
      if (idx === replyResult.length - 1) {
        return undefined;
      }
      continue;
    }

    return payload;
  }

  return undefined;
}
