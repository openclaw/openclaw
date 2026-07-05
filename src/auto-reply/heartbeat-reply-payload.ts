// Heartbeat reply payload selector for multi-payload auto-reply results.
<<<<<<< HEAD
import {
  hasOutboundReplyContent,
  isReasoningReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "./types.js";

/**
 * Pick the last outbound-capable reply payload for heartbeat delivery.
 *
 * Reasoning payloads are skipped using the shared SDK classifier
 * `isReasoningReplyPayload`, which recognizes the `isReasoning` flag plus the
 * common reasoning/thinking text prefixes (including lowercased and Markdown
 * blockquoted forms). Heartbeat reasoning is delivered separately and only when
 * `includeReasoning` is enabled; without this guard a trailing reasoning
 * payload (which reasoning models can emit after the final answer) would be
 * selected as the user-visible heartbeat reply.
 */
=======
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "./types.js";

/** Pick the last outbound-capable reply payload for heartbeat delivery. */
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
export function resolveHeartbeatReplyPayload(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload | undefined {
  if (!replyResult) {
    return undefined;
  }
  if (!Array.isArray(replyResult)) {
<<<<<<< HEAD
    // Scalar results can be reasoning-only too; without this guard a scalar
    // reasoning payload becomes the user-visible reply while the array path
    // filters it, so the leak depends on the result shape.
    return isReasoningReplyPayload(replyResult) ? undefined : replyResult;
=======
    return replyResult;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  }
  for (let idx = replyResult.length - 1; idx >= 0; idx -= 1) {
    const payload = replyResult[idx];
    if (!payload) {
      continue;
    }
<<<<<<< HEAD
    if (isReasoningReplyPayload(payload)) {
      continue;
    }
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    if (hasOutboundReplyContent(payload)) {
      return payload;
    }
  }
  return undefined;
}
