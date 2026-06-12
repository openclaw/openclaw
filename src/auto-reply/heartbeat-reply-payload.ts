// Heartbeat reply payload selector for multi-payload auto-reply results.
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "./types.js";

/**
 * Pick the last outbound-capable reply payload for heartbeat delivery.
 *
 * Reasoning payloads are skipped: heartbeat reasoning is delivered separately
 * and only when `includeReasoning` is enabled. Without this guard a trailing
 * reasoning payload (reasoning models can emit thinking text after the final
 * answer) would be selected as the user-visible heartbeat reply.
 */
export function resolveHeartbeatReplyPayload(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload | undefined {
  if (!replyResult) {
    return undefined;
  }
  if (!Array.isArray(replyResult)) {
    // Scalar results can be reasoning-only too; without this guard a scalar
    // reasoning payload becomes the user-visible reply while the array path
    // filters it, so the leak depends on the result shape.
    return replyResult.isReasoning === true ? undefined : replyResult;
  }
  for (let idx = replyResult.length - 1; idx >= 0; idx -= 1) {
    const payload = replyResult[idx];
    if (!payload) {
      continue;
    }
    if (payload.isReasoning === true) {
      continue;
    }
    if (hasOutboundReplyContent(payload)) {
      return payload;
    }
  }
  return undefined;
}
