import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

const EMPTY_INTERACTIVE_REPLY_TEXT =
  "I finished the turn, but it did not produce a visible reply. Please try again, or start a new session if this keeps happening.";

export function buildEmptyInteractiveReplyPayload(params: {
  isHeartbeat?: boolean;
  hasSuccessfulSideEffectDelivery?: boolean;
  allowEmptyAssistantReplyAsSilent?: boolean;
  silentExpected?: boolean;
  sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
}): ReplyPayload | undefined {
  if (
    params.isHeartbeat === true ||
    params.allowEmptyAssistantReplyAsSilent === true ||
    params.silentExpected === true ||
    params.sourceReplyDeliveryMode === "message_tool_only" ||
    params.hasSuccessfulSideEffectDelivery === true
  ) {
    return undefined;
  }
  return markReplyPayloadForSourceSuppressionDelivery({
    text: EMPTY_INTERACTIVE_REPLY_TEXT,
    isError: true,
  });
}
