import type { ReplyPayload } from "./types.js";

function isUserVisibleHeartbeatPayload(payload: ReplyPayload | undefined): boolean {
  if (!payload) {
    return false;
  }
  if (payload.isReasoning) {
    return false;
  }
  return Boolean(
    payload.text || payload.mediaUrl || (payload.mediaUrls && payload.mediaUrls.length > 0),
  );
}

export function resolveHeartbeatReplyPayload(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload | undefined {
  if (!replyResult) {
    return undefined;
  }
  if (!Array.isArray(replyResult)) {
    return isUserVisibleHeartbeatPayload(replyResult) ? replyResult : undefined;
  }
  for (let idx = replyResult.length - 1; idx >= 0; idx -= 1) {
    const payload = replyResult[idx];
    if (isUserVisibleHeartbeatPayload(payload)) {
      return payload;
    }
  }
  return undefined;
}
