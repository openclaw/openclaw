import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { TypingMode } from "../../config/types.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { TypingPolicy } from "../types.js";
import type { TypingController } from "./typing.js";

/** Inputs that decide when a channel typing indicator should be shown. */
type TypingModeContext = {
  configured?: TypingMode;
  isGroupChat: boolean;
  wasMentioned: boolean;
  isHeartbeat: boolean;
  typingPolicy?: TypingPolicy;
  suppressTyping?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
};

/** Resolves the effective typing mode for the current auto-reply turn. */
export function resolveTypingMode({
  configured,
  isGroupChat,
  wasMentioned,
  isHeartbeat,
  typingPolicy,
  suppressTyping,
  sourceReplyDeliveryMode,
}: TypingModeContext): TypingMode {
  if (
    isHeartbeat ||
    typingPolicy === "heartbeat" ||
    typingPolicy === "system_event" ||
    typingPolicy === "internal_webchat" ||
    suppressTyping
  ) {
    return "never";
  }
  if (configured) {
    return configured;
  }
  if (sourceReplyDeliveryMode === "message_tool_only") {
    return "instant";
  }
  if (!isGroupChat || wasMentioned) {
    return "instant";
  }
  // Group chats wait for visible text to avoid noisy indicators.
  return "message";
}

/** Event-driven typing signaler used by streaming reply dispatch. */
export type TypingSignaler = {
  mode: TypingMode;
  shouldStartImmediately: boolean;
  shouldStartOnMessageStart: boolean;
  shouldStartOnText: boolean;
  shouldStartOnReasoning: boolean;
  signalRunStart: () => Promise<void>;
  signalMessageStart: () => Promise<void>;
  signalTextDelta: (text?: string) => Promise<void>;
  signalReasoningDelta: () => Promise<void>;
  signalToolStart: () => Promise<void>;
  signalExecutionActivity?: () => Promise<void>;
};

/** Creates a typing signaler that starts or refreshes typing from stream events. */
export function createTypingSignaler(params: {
  typing: TypingController;
  mode: TypingMode;
  isHeartbeat: boolean;
}): TypingSignaler {
  const { typing, mode, isHeartbeat } = params;
  const shouldStartImmediately = mode === "instant";
  const shouldStartOnMessageStart = mode === "message";
  const shouldStartOnText = mode === "message" || mode === "instant";
  const shouldStartOnReasoning = mode === "thinking";
  const disabled = isHeartbeat || mode === "never";
  let hasRenderableText = false;

  const refreshTyping = async (allowStart: boolean) => {
    if (!typing.isActive()) {
      if (!allowStart) {
        return;
      }
      await typing.startTypingLoop();
    }
    typing.refreshTypingTtl();
  };

  const isRenderableText = (text?: string): boolean => {
    const trimmed = normalizeOptionalString(text);
    if (!trimmed) {
      return false;
    }
    return !isSilentReplyText(trimmed, SILENT_REPLY_TOKEN);
  };

  return {
    mode,
    shouldStartImmediately,
    shouldStartOnMessageStart,
    shouldStartOnText,
    shouldStartOnReasoning,
    async signalRunStart() {
      if (!disabled && shouldStartImmediately) {
        await typing.startTypingLoop();
      }
    },
    async signalMessageStart() {
      if (!disabled && shouldStartOnMessageStart && hasRenderableText) {
        await typing.startTypingLoop();
      }
    },
    async signalTextDelta(text?: string) {
      if (disabled || !isRenderableText(text)) {
        return;
      }
      hasRenderableText = true;
      if (shouldStartOnText) {
        await typing.startTypingOnText(text);
      } else if (shouldStartOnReasoning) {
        await refreshTyping(true);
      }
    },
    async signalReasoningDelta() {
      if (disabled || !shouldStartOnReasoning) {
        return;
      }
      // Thinking mode starts before visible assistant text arrives.
      await typing.startTypingLoop();
      typing.refreshTypingTtl();
    },
    async signalToolStart() {
      if (!disabled) {
        // Message mode cannot start typing before visible text.
        await refreshTyping(!shouldStartOnMessageStart || hasRenderableText);
      }
    },
    async signalExecutionActivity() {
      if (!disabled) {
        await refreshTyping(true);
      }
    },
  };
}
