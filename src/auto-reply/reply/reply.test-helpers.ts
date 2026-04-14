export function createMockTypingController() {
  return {
    onReplyStart: async () => undefined,
    startTypingLoop: async () => undefined,
    startTypingOnText: async () => undefined,
    refreshTypingTtl: () => undefined,
    enterLongQuietPhase: () => undefined,
    exitLongQuietPhase: () => undefined,
    isActive: () => false,
    markRunComplete: () => undefined,
    markDispatchIdle: () => undefined,
    cleanup: () => undefined,
  };
}
