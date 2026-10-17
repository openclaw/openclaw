import type { InternalChannelThreadingToolContext } from "../../channels/threading-tool-context-internal.js";

export function resolveMessageToolDeliveryContext(
  trustedContext: InternalChannelThreadingToolContext | undefined,
  fallbackContext: InternalChannelThreadingToolContext,
): InternalChannelThreadingToolContext | undefined {
  const context = trustedContext ?? fallbackContext;
  const hasCurrentMessageId =
    typeof context.currentMessageId === "number" ||
    (typeof context.currentMessageId === "string" && context.currentMessageId.trim().length > 0);
  if (
    !trustedContext &&
    !context.currentChannelId &&
    !context.currentChatType &&
    !context.currentChannelProvider &&
    !context.currentMessagingTarget &&
    !context.currentThreadTs &&
    !hasCurrentMessageId &&
    !context.replyToMode &&
    !context.hasRepliedRef &&
    !context.sameChannelThreadRequired
  ) {
    return undefined;
  }
  // Direct tool invocations compose messages, rather than forwarding from another chat.
  return { ...context, skipCrossContextDecoration: true };
}
