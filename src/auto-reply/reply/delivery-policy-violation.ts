import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../reply-payload.js";

export type DeliveryPolicyViolation = {
  reason: "suppressed-final-text-under-message-tool-only";
  sourceReplyDeliveryMode: SourceReplyDeliveryMode;
  finalTextLength: number;
};

export function evaluateDeliveryPolicyViolation(params: {
  reply: ReplyPayload;
  suppressDelivery: boolean;
  sendPolicyDenied: boolean;
  sourceReplyDeliveryMode: SourceReplyDeliveryMode;
}): DeliveryPolicyViolation | null {
  if (!params.suppressDelivery) {
    return null;
  }
  // sendPolicy: deny is an explicit operator deny; do not flag.
  if (params.sendPolicyDenied) {
    return null;
  }
  if (params.sourceReplyDeliveryMode !== "message_tool_only") {
    return null;
  }
  // Reasoning/compaction notices and metadata-only payloads are not substantive
  // user-facing finals; let dispatch's existing filters handle them.
  if (params.reply.isReasoning === true || params.reply.isCompactionNotice === true) {
    return null;
  }
  const text = typeof params.reply.text === "string" ? params.reply.text.trim() : "";
  if (text.length === 0) {
    return null;
  }
  return {
    reason: "suppressed-final-text-under-message-tool-only",
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    finalTextLength: text.length,
  };
}

export function formatDeliveryPolicyViolationLog(params: {
  violation: DeliveryPolicyViolation;
  channel: string | undefined;
  sessionKey: string | undefined;
}): string {
  return (
    `delivery-policy-violation: ${params.violation.reason}` +
    ` channel=${params.channel ?? "unknown"}` +
    ` session=${params.sessionKey ?? "unknown"}` +
    ` sourceReplyDeliveryMode=${params.violation.sourceReplyDeliveryMode}` +
    ` finalTextLength=${params.violation.finalTextLength}`
  );
}
