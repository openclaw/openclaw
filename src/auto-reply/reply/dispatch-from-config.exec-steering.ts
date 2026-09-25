import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "../reply-payload.js";

/**
 * Whether a turn that folded in steered exec completions settled its reply.
 * Only the turn's own evidence counts: a model final whose exact dispatch
 * settled as delivered, or the run's settled current-source delivery (a
 * committed message-tool send or a directly delivered block reply). A generic
 * no-visible-reply notice sent after the final failed is not that evidence, and
 * a message-tool-only turn with no confirmed send returns the completion for
 * recovery. An automatic-mode turn with no outbound reply content (a deliberate
 * silent reply) consumed the completion itself.
 */
export function isExecSteeringReplySettled(params: {
  replies: readonly ReplyPayload[] | undefined;
  finalDelivered: readonly boolean[];
  sourceReplyDelivered: boolean;
  messageToolOnly: boolean;
}): boolean {
  if (!params.replies) {
    return false;
  }
  if (params.sourceReplyDelivered || params.finalDelivered.includes(true)) {
    return true;
  }
  if (params.messageToolOnly) {
    return false;
  }
  return !params.replies.some((reply) => hasOutboundReplyContent(reply, { trimText: true }));
}
