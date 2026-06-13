// Heartbeat reply payload selector for multi-payload auto-reply results.
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "./types.js";

// Formatted reasoning prefixes the heartbeat reasoning lane classifies as
// reasoning even when the `isReasoning` flag is absent: legacy "Reasoning:"
// text and blockquoted "Thinking..._". Kept in sync with
// resolveHeartbeatReasoningPayloads (heartbeat-runner) so the selector skips
// exactly the payloads the reasoning lane delivers separately.
const FORMATTED_REASONING_PREFIX = /^(?:Reasoning:|Thinking\.{0,3}(?=\s*_))/u;

/** Whether text already carries a formatted reasoning prefix (legacy reasoning). */
export function hasFormattedReasoningPrefix(text: string): boolean {
  return FORMATTED_REASONING_PREFIX.test(text.trimStart());
}

/**
 * Whether a payload is reasoning (flagged or legacy-formatted) and so must not
 * become the user-visible heartbeat reply.
 */
export function isReasoningReplyPayload(payload: ReplyPayload): boolean {
  if (payload.isReasoning === true) {
    return true;
  }
  const text = typeof payload.text === "string" ? payload.text : "";
  return hasFormattedReasoningPrefix(text);
}

/**
 * Pick the last outbound-capable reply payload for heartbeat delivery.
 *
 * Reasoning payloads are skipped: heartbeat reasoning is delivered separately
 * and only when `includeReasoning` is enabled. Without this guard a trailing
 * reasoning payload (flagged via `isReasoning` or legacy "Reasoning:" /
 * blockquoted "Thinking" text, which reasoning models can emit after the final
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
    return isReasoningReplyPayload(replyResult) ? undefined : replyResult;
  }
  for (let idx = replyResult.length - 1; idx >= 0; idx -= 1) {
    const payload = replyResult[idx];
    if (!payload) {
      continue;
    }
    if (isReasoningReplyPayload(payload)) {
      continue;
    }
    if (hasOutboundReplyContent(payload)) {
      return payload;
    }
  }
  return undefined;
}
