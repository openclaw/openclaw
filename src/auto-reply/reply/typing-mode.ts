import type { TypingMode } from "../../config/types.js";
import type { TypingController } from "./typing.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";

export type TypingModeContext = {
  configured?: TypingMode;
  isGroupChat: boolean;
  wasMentioned: boolean;
  isHeartbeat: boolean;
};

export const DEFAULT_GROUP_TYPING_MODE: TypingMode = "message";

export function resolveTypingMode({
  configured,
  isGroupChat,
  wasMentioned,
  isHeartbeat,
}: TypingModeContext): TypingMode {
  if (isHeartbeat) {
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

/**
 * Check whether `accumulated` could still become the silent reply token.
 * Returns true if the token starts with the accumulated text (case-sensitive).
 */
function couldBeSilentPrefix(accumulated: string, token: string = SILENT_REPLY_TOKEN): boolean {
  const trimmed = accumulated.trim();
  if (!trimmed) {
    return true; // empty string is a prefix of anything
  }
  return token.startsWith(trimmed);
}

export function createTypingSignaler(params: {
  typing: TypingController;
  mode: TypingMode;
  isHeartbeat: boolean;
}): TypingSignaler {
  const { typing, mode, isHeartbeat } = params;
  const isDeferred = mode === "deferred";
  const shouldStartImmediately = mode === "instant";
  const shouldStartOnMessageStart = mode === "message" || isDeferred;
  const shouldStartOnText = mode === "message" || mode === "instant" || isDeferred;
  const shouldStartOnReasoning = mode === "thinking";
  const disabled = isHeartbeat || mode === "never";
  let hasRenderableText = false;

  // Deferred mode: accumulate streamed text to check for NO_REPLY prefix
  let deferredAccumulated = "";
  let deferredConfirmedReal = false;

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
    // Deferred mode never starts on run start
    if (isDeferred) {
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
    // In deferred mode, only start if we've confirmed non-silent text
    if (isDeferred && !deferredConfirmedReal) {
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

    // Deferred mode: accumulate text and only start typing once we're sure
    // the response is not a silent reply (e.g. NO_REPLY).
    if (isDeferred) {
      if (deferredConfirmedReal) {
        // Already confirmed — behave like "message" mode
        await typing.startTypingOnText(text);
        return;
      }
      deferredAccumulated += text ?? "";
      if (couldBeSilentPrefix(deferredAccumulated)) {
        // Still ambiguous — could become NO_REPLY. Don't start typing yet.
        return;
      }
      if (isSilentReplyText(deferredAccumulated.trim(), SILENT_REPLY_TOKEN)) {
        // It IS a silent reply — never start typing.
        return;
      }
      // Accumulated text diverged from the silent token — this is a real reply.
      deferredConfirmedReal = true;
      await typing.startTypingOnText(text);
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
    // In deferred mode, tool execution confirms the agent is doing real work.
    if (isDeferred) {
      deferredConfirmedReal = true;
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
