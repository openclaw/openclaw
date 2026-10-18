/** Visible-reply ownership and presentation guidance shared with agent harnesses. */
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
    : "`send`: `message`; current source is default target. Set `target` only elsewhere.";
}

/** States when a message send ends this turn, if the run changes the default. */
export function buildMessageToolFinalityGuidance(
  messageToolFinalByDefault: boolean | undefined,
): string | undefined {
  return messageToolFinalByDefault === false
    ? "A send ends this turn only with `final=true`. With `final` omitted, the turn continues after the send, so finish every remaining step."
    : undefined;
}

export function buildHarnessVisibleReplyGuidance(params: {
  sourceReplyDeliveryMode?: string;
  messageToolAvailable: boolean;
  requireExplicitMessageTarget?: boolean;
  messageToolFinalByDefault?: boolean;
  uiPresentation?: Parameters<typeof buildUiPresentationPrompt>[0];
}): string {
  const omittedFinalCompletes = params.messageToolFinalByDefault !== false;
  const deliveryGuidance = messageToolOwnsVisibleReply(params)
    ? params.messageToolAvailable
      ? `Visible source replies are not automatically delivered for this run. Use \`message(action=send)\` for source output. For progress, set \`final=false\`. Set \`final=true\`${omittedFinalCompletes ? ", or omit it," : ""} for a completed reply to the current source. An added reaction to the current source message with \`final=true\` can also complete the reply. Do not repeat delivered content.`
      : "No source-conversation reply can be sent from this turn. Final assistant text remains private and returns to the invoking workflow; it is not automatically delivered to the source conversation."
    : params.messageToolAvailable
      ? `Use \`message\` with \`final=false\` for progress. A completed send to the current source conversation (\`final=true\`${omittedFinalCompletes ? ", or omitted" : ""}) or an added reaction to its current message with \`final=true\` is your complete reply. Do not repeat delivered content. Otherwise, OpenClaw delivers your final response automatically.`
      : "For the current source conversation, reply normally in your final assistant message; OpenClaw will deliver it through the active source conversation.";
  const targetGuidance =
    params.messageToolAvailable && params.requireExplicitMessageTarget !== undefined
      ? buildMessageToolTargetGuidance(params.requireExplicitMessageTarget)
      : undefined;
  const pendingReplyGuidance = params.messageToolAvailable
    ? "Commentary is optional progress and may be hidden. Answer user questions or status requests received during ongoing work with `message(action=send, final=false)`, then continue the task. Before finishing, deliver every still-pending answer through this turn's visible-reply route. Do not repeat answers already delivered."
    : !messageToolOwnsVisibleReply(params)
      ? "Commentary is optional progress and may be hidden. Include answers to every still-pending user question, including questions received during ongoing work, in your final response."
      : undefined;
  return [
    deliveryGuidance,
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
