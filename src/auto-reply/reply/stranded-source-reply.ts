import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";

const strandedReplyLogger = createSubsystemLogger("source-reply/stranded");

/**
 * A "stranded" reply is a real final agent message that gets kept private under
 * `message_tool_only` delivery even though the agent never delivered anything
 * via the message tool this turn. This is the silent message-loss path from
 * #85714: the model forgot to call the configured delivery tool and emitted the
 * response as plain final text, so it is dropped instead of reaching the user.
 *
 * We deliberately do NOT auto-deliver the text (that would defeat the documented
 * "keep final text private" guarantee of `messages.visibleReplies: "message_tool"`);
 * we only make the loss observable.
 */
export function isStrandedMessageToolReply(params: {
  sourceReplyDeliveryMode: SourceReplyDeliveryMode | undefined;
  sendPolicyDenied: boolean;
  successfulSideEffectDelivery: boolean;
  finalText: string;
}): boolean {
  if (params.sourceReplyDeliveryMode !== "message_tool_only") {
    return false;
  }
  // A send-policy denial is an intentional block, and a successful tool/block
  // delivery means the contract was honored — neither is message loss.
  if (params.sendPolicyDenied || params.successfulSideEffectDelivery) {
    return false;
  }
  const trimmed = params.finalText.trim();
  if (!trimmed || trimmed === SILENT_REPLY_TOKEN) {
    return false;
  }
  return true;
}

/**
 * Emit a WARN so operators can see that a generated reply was kept private and
 * never delivered. The response body is intentionally omitted — `message_tool_only`
 * keeps final text private by design, so only metadata is logged.
 */
export function warnStrandedMessageToolReply(params: {
  sessionKey: string | undefined;
  channel: string | undefined;
  finalTextLength: number;
}): void {
  strandedReplyLogger.warn(
    "agent produced a final reply but never called the configured delivery tool (message_tool_only); response kept private and not delivered to the source channel",
    {
      sessionKey: params.sessionKey,
      channel: params.channel,
      chars: params.finalTextLength,
    },
  );
}
