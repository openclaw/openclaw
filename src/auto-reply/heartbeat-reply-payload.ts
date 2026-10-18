import {
  hasOutboundReplyContent,
  isReasoningReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { getReplyPayloadMetadata } from "./reply-payload.js";
import type { ReplyPayload } from "./types.js";

export type HeartbeatTerminalToolFailure = {
  toolName: string;
};

/** Resolve structured terminal tool-failure state carried by an agent reply. */
export function resolveHeartbeatTerminalToolFailure(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): HeartbeatTerminalToolFailure | undefined {
  if (!replyResult) {
    return undefined;
  }
  const payloads = Array.isArray(replyResult) ? replyResult : [replyResult];
  const payload = payloads.findLast(
    (entry) => entry && getReplyPayloadMetadata(entry)?.heartbeatTerminalToolFailure,
  );
  return payload ? getReplyPayloadMetadata(payload)?.heartbeatTerminalToolFailure : undefined;
}

/**
 * Pick the last outbound-capable reply, excluding flagged and text-prefixed reasoning.
 * Scalar replies intentionally need no outbound-content check.
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
