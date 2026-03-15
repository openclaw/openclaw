import type { TypingMode } from "../../config/types.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { TypingPolicy } from "../types.js";
import type { TypingController } from "./typing.js";

export type TypingModeContext = {
  configured?: TypingMode;
  isGroupChat: boolean;
  wasMentioned: boolean;
  isHeartbeat: boolean;
  typingPolicy?: TypingPolicy;
  suppressTyping?: boolean;
};

export const DEFAULT_GROUP_TYPING_MODE: TypingMode = "message";

export function resolveTypingMode({
  configured,
  isGroupChat,
  wasMentioned,
  isHeartbeat,
  typingPolicy,
  suppressTyping,
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
  if (!isGroupChat || wasMentioned) {
    return "instant";
  }
  return DEFAULT_GROUP_TYPING_MODE;
}

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
};

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

  const isRenderableText = (text?: string): boolean => {
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

  const signalTextDelta = async (text?: string) => {
    if (disabled) {
      return;
    }
    const renderable = isRenderableText(text);
    if (renderable) {
      hasRenderableText = true;
    } else if (text?.trim()) {
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
    // In "message" or "thinking" mode, tool execution should not start the
    // typing indicator on its own.  Only refresh the TTL when typing is
    // already active (started by a prior text/reasoning delta).  Without
    // this guard, long sequences of tool calls (web searches, exec, etc.)
    // keep the typing indicator alive for minutes even though no reply text
    // has been emitted yet — which is confusing on channels like Telegram.
    if (shouldStartOnMessageStart || shouldStartOnReasoning) {
      if (typing.isActive()) {
        typing.refreshTypingTtl();
      }
      return;
    }
    // "instant" mode: start typing as soon as tools begin executing.
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
