import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
export function resolveRunTypingPolicy(params) {
    const typingPolicy = params.isHeartbeat
        ? "heartbeat"
        : params.originatingChannel === INTERNAL_MESSAGE_CHANNEL
            ? "internal_webchat"
            : params.systemEvent
                ? "system_event"
                : (params.requestedPolicy ?? "auto");
    const suppressTyping = params.suppressTyping === true ||
        typingPolicy === "heartbeat" ||
        typingPolicy === "system_event" ||
        typingPolicy === "internal_webchat";
    return { typingPolicy, suppressTyping };
}
