import { describe, expect, it } from "vitest";
import {
  buildOpenAICompatibleReplayPolicy,
  buildStrictAnthropicReplayPolicy,
} from "./provider-replay-helpers.js";

describe("provider replay helpers", () => {
  it("builds strict openai-completions replay policy", () => {
    expect(buildOpenAICompatibleReplayPolicy("openai-completions")).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });
  });

  it("builds strict anthropic replay policy", () => {
    expect(buildStrictAnthropicReplayPolicy({ dropThinkingBlocks: true })).toMatchObject({
      sanitizeMode: "full",
      preserveSignatures: true,
      repairToolUseResultPairing: true,
      allowSyntheticToolResults: true,
      dropThinkingBlocks: true,
    });
  });
});
