// Heartbeat reply payload selector for multi-payload auto-reply results.
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "./types.js";

export interface ResolveHeartbeatReplyPayloadOptions {
  /** When false, skip reasoning/thinking payloads (isReasoning === true). */
  includeReasoning?: boolean;
}

/** Pick the last outbound-capable reply payload for heartbeat delivery. */
export function resolveHeartbeatReplyPayload(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
  options?: ResolveHeartbeatReplyPayloadOptions,
): ReplyPayload | undefined {
  if (!replyResult) {
    return undefined;
  }
  if (!Array.isArray(replyResult)) {
    if (options?.includeReasoning === false && replyResult.isReasoning === true) {
      return undefined;
    }
    return replyResult;
  }
  const skipReasoning = options?.includeReasoning === false;
  for (let idx = replyResult.length - 1; idx >= 0; idx -= 1) {
    const payload = replyResult[idx];
    if (!payload) {
      continue;
    }
    if (skipReasoning && payload.isReasoning === true) {
      continue;
    }
    if (hasOutboundReplyContent(payload)) {
      return payload;
    }
  }
  return undefined;
}
