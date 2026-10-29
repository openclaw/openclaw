// Shared reply test helpers for mocked typing and delivery callbacks.
import type { TypingSignaler } from "./typing-mode.js";

export function createMockTypingController() {
  return {
    onReplyStart: async () => undefined,
    startTypingLoop: async () => undefined,
    startTypingOnText: async () => undefined,
    refreshTypingTtl: () => undefined,
    isActive: () => false,
    markRunComplete: () => undefined,
    markDispatchIdle: () => undefined,
    cleanup: () => undefined,
  };
}

export function createQuietTypingSignaler(): TypingSignaler {
  return {
    mode: "never",
    shouldStartImmediately: false,
    shouldStartOnMessageStart: false,
    shouldStartOnText: false,
    shouldStartOnReasoning: false,
    signalRunStart: async () => {},
    signalMessageStart: async () => {},
    signalTextDelta: async () => {},
    signalReasoningDelta: async () => {},
    signalToolStart: async () => {},
  };
}
