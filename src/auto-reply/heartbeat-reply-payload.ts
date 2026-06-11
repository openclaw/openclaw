// Heartbeat reply payload selector for multi-payload auto-reply results.
import {
  hasOutboundReplyContent,
  isReasoningReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "./types.js";

export function hasHeartbeatReasoningPrefix(text: string): boolean {
  return isReasoningReplyPayload({ text });
}

export function isHeartbeatReasoningPayload(
  payload: Pick<ReplyPayload, "isReasoning" | "text">,
): boolean {
  return isReasoningReplyPayload(payload);
}

/** Pick the last non-reasoning outbound-capable reply payload for heartbeat delivery. */
export function resolveHeartbeatReplyPayload(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload | undefined {
  if (!replyResult) {
    return undefined;
  }
  if (!Array.isArray(replyResult)) {
    return isHeartbeatReasoningPayload(replyResult) ? undefined : replyResult;
  }
  for (let idx = replyResult.length - 1; idx >= 0; idx -= 1) {
    const payload = replyResult[idx];
    if (!payload) {
      continue;
    }
    if (isHeartbeatReasoningPayload(payload)) {
      continue;
    }
    if (hasOutboundReplyContent(payload)) {
      return payload;
    }
  }
  return undefined;
}
