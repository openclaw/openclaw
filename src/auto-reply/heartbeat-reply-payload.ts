// Heartbeat reply payload selector for multi-payload auto-reply results.
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "./types.js";

const HEARTBEAT_REASONING_PREFIX_PATTERN = /^(?:Reasoning:|Thinking\.{0,3}(?=\s*_))/u;

export function hasHeartbeatReasoningPrefix(text: string): boolean {
  return HEARTBEAT_REASONING_PREFIX_PATTERN.test(text.trimStart());
}

export function isHeartbeatReasoningPayload(
  payload: Pick<ReplyPayload, "isReasoning" | "text">,
): boolean {
  const text = typeof payload.text === "string" ? payload.text : "";
  return payload.isReasoning === true || hasHeartbeatReasoningPrefix(text);
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
