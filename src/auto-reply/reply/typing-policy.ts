import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { TypingPolicy } from "../types.js";

/** Resolves typing policy and suppresses typing for non-user-visible turns. */
export function resolveRunTypingPolicy(params: {
  requestedPolicy?: TypingPolicy;
  suppressTyping?: boolean;
  originatingChannel?: string;
  systemEvent?: boolean;
}): {
  typingPolicy: TypingPolicy;
  suppressTyping: boolean;
} {
  const typingPolicy =
    params.originatingChannel === INTERNAL_MESSAGE_CHANNEL
      ? "internal_webchat"
      : params.systemEvent
        ? "system_event"
        : (params.requestedPolicy ?? "auto");

  const suppressTyping =
    params.suppressTyping === true ||
    typingPolicy === "system_event" ||
    typingPolicy === "internal_webchat";

  return { typingPolicy, suppressTyping };
}
