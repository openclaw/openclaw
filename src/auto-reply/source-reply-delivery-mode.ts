/** Visible-reply ownership and presentation guidance shared with agent harnesses. */
import { hasMessageToolSourceConversation } from "../agents/tools/message-tool-discovery.js";
import { buildUiPresentationPrompt } from "../agents/ui-presentation-prompt.js";

/**
 * True when the visible source reply must flow through the message tool, either
 * because the run forces it or because the delivery mode is message_tool_only.
 * Consumers use this to keep the message tool visible/preserved: hiding the only
 * reply path leaves the run mute. The mode is accepted as plain string because
 * harness callers carry it untyped; only "message_tool_only" is meaningful here.
 */
export function messageToolOwnsVisibleReply(params: {
  forceMessageTool?: boolean;
  sourceReplyDeliveryMode?: string;
}): boolean {
  return params.forceMessageTool === true || params.sourceReplyDeliveryMode === "message_tool_only";
}

export function buildMessageToolTargetGuidance(requireExplicitMessageTarget: boolean): string {
  return requireExplicitMessageTarget
    ? "`send`: `target` + `message`; target required this turn."
    : "`send`: `message`; this conversation is the default target. Set `target` only for another destination.";
}

/** States the omitted-final behavior when the run changes the send default. */
export function buildMessageToolFinalityGuidance(
  messageToolFinalByDefault: boolean | undefined,
): string | undefined {
  return messageToolFinalByDefault === false
    ? "For sends this turn, omitting `final` means `final=false`. After a nonfinal send, continue any remaining work. Set `final=true` only after finishing the work and including all pending answers."
    : undefined;
}

export function buildHarnessVisibleReplyGuidance(params: {
  sourceReplyDeliveryMode?: string;
  messageToolAvailable: boolean;
  currentConversation: NonNullable<Parameters<typeof hasMessageToolSourceConversation>[0]>;
  requireExplicitMessageTarget?: boolean;
  messageToolFinalByDefault?: boolean;
  uiPresentation?: Parameters<typeof buildUiPresentationPrompt>[0];
}): string {
  if (!hasMessageToolSourceConversation(params.currentConversation)) {
    return [
      "This turn has no current conversation. Reply normally in your final assistant message; OpenClaw delivers your final response automatically to the caller.",
      params.messageToolAvailable ? buildMessageToolTargetGuidance(true) : undefined,
      params.messageToolAvailable
        ? buildMessageToolFinalityGuidance(params.messageToolFinalByDefault)
        : undefined,
      "Include all pending answers in your final response; do not rely on intermediate narration being delivered.",
      params.uiPresentation ? buildUiPresentationPrompt(params.uiPresentation) : undefined,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  const omittedFinalCompletes = params.messageToolFinalByDefault !== false;
  const deliveryGuidance = messageToolOwnsVisibleReply(params)
    ? params.messageToolAvailable
      ? "Your final response is not automatically sent here for this turn. You MUST use `message(action=send)` for visible text replies here."
      : "No reply can be sent to this conversation from this turn. Your final response returns to the invoking workflow; it is not sent to this conversation."
    : params.messageToolAvailable
      ? "OpenClaw delivers your final response automatically unless you have already completed the reply to this conversation with the message tool."
      : "For the current source conversation, reply normally in your final assistant message; OpenClaw will deliver it through the active source conversation.";
  const targetGuidance =
    params.messageToolAvailable && params.requireExplicitMessageTarget !== undefined
      ? buildMessageToolTargetGuidance(params.requireExplicitMessageTarget)
      : undefined;
  const pendingReplyGuidance = params.messageToolAvailable
    ? "Deliver all pending answers before finishing; do not rely on narration being delivered."
    : !messageToolOwnsVisibleReply(params)
      ? "Include all pending answers in your final response; do not rely on intermediate narration being delivered."
      : undefined;
  return [
    deliveryGuidance,
    params.messageToolAvailable
      ? `Use \`message(action=send, final=false)\` for chat updates and mid-task answers, then resume work. Set \`final=true\`${omittedFinalCompletes ? ", or omit it," : ""} for a completed reply to this conversation. Finish work before that send; do not expect another model step after confirmed final delivery. You MUST NOT repeat it in your final response or another send. If reactions are permitted, adding a reaction to the current message with \`final=true\` can also complete the reply.`
      : undefined,
    targetGuidance,
    params.messageToolAvailable
      ? buildMessageToolFinalityGuidance(params.messageToolFinalByDefault)
      : undefined,
    pendingReplyGuidance,
    params.uiPresentation ? buildUiPresentationPrompt(params.uiPresentation) : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
}
