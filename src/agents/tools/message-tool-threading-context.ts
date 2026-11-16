import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import type { ChannelThreadingToolContext } from "../../channels/plugins/types.core.js";
import type { MessageToolOptions } from "./message-tool-execution.types.js";

type CurrentChannel = Pick<
  ChannelThreadingToolContext,
  "currentChannelId" | "currentChatType" | "currentChannelProvider" | "currentMessagingTarget"
>;

/** Threading context for a direct tool send; undefined when the run carries no channel facts. */
export function buildMessageToolThreadingContext(
  current: CurrentChannel,
  thread: Pick<ChannelThreadingToolContext, "currentThreadTs" | "replyToMode">,
  options: MessageToolOptions | undefined,
): ChannelThreadingToolContext | undefined {
  if (
    !current.currentChannelId &&
    !current.currentChatType &&
    !current.currentChannelProvider &&
    !current.currentMessagingTarget &&
    !thread.currentThreadTs &&
    typeof options?.currentMessageId !== "number" &&
    !hasNonEmptyString(options?.currentMessageId) &&
    !thread.replyToMode &&
    !options?.hasRepliedRef &&
    !options?.sameChannelThreadRequired
  ) {
    return undefined;
  }
  return {
    currentChannelId: current.currentChannelId,
    currentChatType: current.currentChatType,
    currentMessagingTarget: current.currentMessagingTarget,
    currentChannelProvider: current.currentChannelProvider,
    currentThreadTs: thread.currentThreadTs,
    currentMessageId: options?.currentMessageId,
    replyToMode: thread.replyToMode,
    hasRepliedRef: options?.hasRepliedRef,
    sameChannelThreadRequired: options?.sameChannelThreadRequired,
    // Direct tool invocations should not add cross-context decoration.
    // The agent is composing a message, not forwarding from another chat.
    skipCrossContextDecoration: true,
  };
}
