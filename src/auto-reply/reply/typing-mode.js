import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
export const DEFAULT_GROUP_TYPING_MODE = "message";
export function resolveTypingMode({ configured, isGroupChat, wasMentioned, isHeartbeat, typingPolicy, suppressTyping, }) {
    if (isHeartbeat ||
        typingPolicy === "heartbeat" ||
        typingPolicy === "system_event" ||
        typingPolicy === "internal_webchat" ||
        suppressTyping) {
        return "never";
    }
    if (configured) {
        return configured;
    }
    if (!isGroupChat || wasMentioned) {
        return "instant";
    }
    return DEFAULT_GROUP_TYPING_MODE;
}
export function createTypingSignaler(params) {
    const { typing, mode, isHeartbeat } = params;
    const shouldStartImmediately = mode === "instant";
    const shouldStartOnMessageStart = mode === "message";
    const shouldStartOnText = mode === "message" || mode === "instant";
    const shouldStartOnReasoning = mode === "thinking";
    const disabled = isHeartbeat || mode === "never";
    let hasRenderableText = false;
    const isRenderableText = (text) => {
        const trimmed = text?.trim();
        if (!trimmed) {
            return false;
        }
        return !isSilentReplyText(trimmed, SILENT_REPLY_TOKEN);
    };
    const signalRunStart = async () => {
        if (disabled || !shouldStartImmediately) {
            return;
        }
        await typing.startTypingLoop();
    };
    const signalMessageStart = async () => {
        if (disabled || !shouldStartOnMessageStart) {
            return;
        }
        if (!hasRenderableText) {
            return;
        }
        await typing.startTypingLoop();
    };
    const signalTextDelta = async (text) => {
        if (disabled) {
            return;
        }
        const renderable = isRenderableText(text);
        if (renderable) {
            hasRenderableText = true;
        }
        else if (text?.trim()) {
            return;
        }
        if (shouldStartOnText) {
            await typing.startTypingOnText(text);
            return;
        }
        if (shouldStartOnReasoning) {
            if (!typing.isActive()) {
                await typing.startTypingLoop();
            }
            typing.refreshTypingTtl();
        }
    };
    const signalReasoningDelta = async () => {
        if (disabled || !shouldStartOnReasoning) {
            return;
        }
        if (!hasRenderableText) {
            return;
        }
        await typing.startTypingLoop();
        typing.refreshTypingTtl();
    };
    const signalToolStart = async () => {
        if (disabled) {
            return;
        }
        // Start typing as soon as tools begin executing, even before the first text delta.
        if (!typing.isActive()) {
            await typing.startTypingLoop();
            typing.refreshTypingTtl();
            return;
        }
        // Keep typing indicator alive during tool execution.
        typing.refreshTypingTtl();
    };
    return {
        mode,
        shouldStartImmediately,
        shouldStartOnMessageStart,
        shouldStartOnText,
        shouldStartOnReasoning,
        signalRunStart,
        signalMessageStart,
        signalTextDelta,
        signalReasoningDelta,
        signalToolStart,
    };
}
