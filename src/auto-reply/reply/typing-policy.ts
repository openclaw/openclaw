import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { TypingPolicy } from "../types.js";

export type ResolveRunTypingPolicyParams = {
  requestedPolicy?: TypingPolicy;
  suppressTyping?: boolean;
  isHeartbeat?: boolean;
  originatingChannel?: string;
  systemEvent?: boolean;
};

export type ResolvedRunTypingPolicy = {
  typingPolicy: TypingPolicy;
  suppressTyping: boolean;
};

export function resolveRunTypingPolicy(
  params: ResolveRunTypingPolicyParams,
): ResolvedRunTypingPolicy {
  const typingPolicy = params.isHeartbeat
    ? "heartbeat"
    : params.originatingChannel === INTERNAL_MESSAGE_CHANNEL
      ? "internal_webchat"
      : params.systemEvent
        ? "system_event"
        : (params.requestedPolicy ?? "auto");

  const suppressTyping =
    params.suppressTyping === true ||
    typingPolicy === "heartbeat" ||
    typingPolicy === "system_event" ||
    typingPolicy === "internal_webchat";

  return { typingPolicy, suppressTyping };
}
