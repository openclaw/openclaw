import type { RunReplyAgentParams } from "./agent-runner-core.js";
import { createMockTypingController } from "./test-helpers.js";

export function createReplyParams(
  overrides: Pick<RunReplyAgentParams, "followupRun"> & Partial<RunReplyAgentParams>,
): RunReplyAgentParams {
  return {
    commandBody: "hello",
    queueKey: "main",
    resolvedQueue: { mode: "interrupt" },
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    typing: overrides.typing ?? createMockTypingController(),
    sessionCtx: {},
    defaultModel: "anthropic/claude",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
    ...overrides,
  };
}
