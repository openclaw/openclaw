import { hasVisibleAgentPayload } from "../../agents/embedded-agent-runner/delivery-evidence.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

export const EMPTY_INTERACTIVE_REPLY_FALLBACK_TEXT =
  "I finished the turn, but it did not produce a visible reply. Please try again, or start a new session if this keeps happening.";

function hasNonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry) => typeof entry === "string" && entry.trim());
}

function hasCommittedMessagingTargetDeliveryEvidence(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const record = entry as { text?: unknown; mediaUrls?: unknown };
    if ("text" in record || "mediaUrls" in record) {
      return (
        (typeof record.text === "string" && record.text.trim().length > 0) ||
        hasNonEmptyStringArray(record.mediaUrls)
      );
    }
    return true;
  });
}

export function hasCommittedSourceReplyDeliveryEvidence(params: {
  didSendViaMessagingTool?: boolean;
  didDeliverSourceReplyViaMessageTool?: boolean;
  messagingToolSentTexts?: string[];
  messagingToolSentMediaUrls?: string[];
  messagingToolSentTargets?: unknown[];
  messagingToolSourceReplyPayloads?: ReplyPayload[];
}): boolean {
  return (
    params.didSendViaMessagingTool === true ||
    params.didDeliverSourceReplyViaMessageTool === true ||
    hasNonEmptyStringArray(params.messagingToolSentTexts) ||
    hasNonEmptyStringArray(params.messagingToolSentMediaUrls) ||
    hasCommittedMessagingTargetDeliveryEvidence(params.messagingToolSentTargets) ||
    hasVisibleAgentPayload({ payloads: params.messagingToolSourceReplyPayloads })
  );
}

export function buildEmptyInteractiveReplyFallbackPayload(params: {
  isHeartbeat?: boolean;
  silentExpected?: boolean;
  allowEmptyAssistantReplyAsSilent?: boolean;
  sourceReplyDeliveryMode?: string;
  hasSuccessfulSideEffectDelivery?: boolean;
}): ReplyPayload | undefined {
  if (
    params.isHeartbeat === true ||
    params.silentExpected === true ||
    params.allowEmptyAssistantReplyAsSilent === true ||
    params.sourceReplyDeliveryMode === "message_tool_only" ||
    params.hasSuccessfulSideEffectDelivery === true
  ) {
    return undefined;
  }

  return markReplyPayloadForSourceSuppressionDelivery({
    text: EMPTY_INTERACTIVE_REPLY_FALLBACK_TEXT,
    isError: true,
  });
}
