// Heartbeat reply payload selector for multi-payload auto-reply results.
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { getReplyPayloadMetadata } from "./reply-payload.js";
import type { ReplyPayload } from "./types.js";

/** Pick the last outbound-capable reply payload for heartbeat delivery. */
export function resolveHeartbeatReplyPayload(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload | undefined {
  if (!replyResult) {
    return undefined;
  }
  if (!Array.isArray(replyResult)) {
    return replyResult;
  }
  for (let idx = replyResult.length - 1; idx >= 0; idx -= 1) {
    const payload = replyResult[idx];
    if (!payload) {
      continue;
    }
    if (hasOutboundReplyContent(payload)) {
      return payload;
    }
  }
  return undefined;
}

export function hasHeartbeatMessageToolDeliveryEvidence(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): boolean {
  const replyPayload = resolveHeartbeatReplyPayload(replyResult);
  if (!replyPayload) {
    return false;
  }
  return getReplyPayloadMetadata(replyPayload)?.messageToolDeliveredForReplyRoute === true;
}
