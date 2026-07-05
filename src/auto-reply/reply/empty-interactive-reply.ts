import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

export const EMPTY_INTERACTIVE_REPLY_FALLBACK_TEXT =
  "I finished the turn, but it did not produce a visible reply. Please try again, or start a new session if this keeps happening.";

export function buildEmptyInteractiveReplyFallbackPayload(params: {
  isInteractive: boolean;
  isHeartbeat?: boolean;
  silentExpected?: boolean;
  allowEmptyAssistantReplyAsSilent?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  hasPendingContinuation?: boolean;
  hasExplicitSilentReply?: boolean;
  hasSuccessfulTerminalDelivery?: boolean;
}): ReplyPayload | undefined {
  if (
    !params.isInteractive ||
    params.isHeartbeat === true ||
    params.silentExpected === true ||
    params.allowEmptyAssistantReplyAsSilent === true ||
    params.sourceReplyDeliveryMode === "message_tool_only" ||
    params.hasPendingContinuation === true ||
    params.hasExplicitSilentReply === true ||
    params.hasSuccessfulTerminalDelivery === true
  ) {
    return undefined;
  }

  return markReplyPayloadForSourceSuppressionDelivery({
    text: EMPTY_INTERACTIVE_REPLY_FALLBACK_TEXT,
    isError: true,
  });
}
