import {
  hasOutboundReplyContent,
  isReasoningReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "./types.js";

/**
 * Pick the last outbound-capable reply, excluding flagged and text-prefixed reasoning.
 * Scalar replies intentionally need no outbound-content check.
 * @deprecated Stable SDK projection only; ordinary turns use reply finalization.
 */
export function resolveHeartbeatReplyPayload(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload | undefined {
  if (!replyResult) {
    return undefined;
  }
  if (!Array.isArray(replyResult)) {
    return isReasoningReplyPayload(replyResult) ? undefined : replyResult;
  }
  return replyResult.findLast(
    (payload) => payload && !isReasoningReplyPayload(payload) && hasOutboundReplyContent(payload),
  );
}
