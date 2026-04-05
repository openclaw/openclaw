import { describe, expect, it } from "vitest";
import {
  buildAnthropicReplayPolicyForModel,
  buildGoogleGeminiReplayPolicy,
  buildHybridAnthropicOrOpenAIReplayPolicy,
  buildNativeAnthropicReplayPolicyForModel,
  buildOpenAICompatibleReplayPolicy,
  buildPassthroughGeminiSanitizingReplayPolicy,
  resolveTaggedReasoningOutputMode,
  sanitizeGoogleGeminiReplayHistory,
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

  it("derives claude-only anthropic replay policy from the model id", () => {
    expect(buildAnthropicReplayPolicyForModel("claude-sonnet-4-6")).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      dropThinkingBlocks: true,
      validateAnthropicTurns: true,
    });
    expect(buildAnthropicReplayPolicyForModel("amazon.nova-pro-v1")).not.toHaveProperty(
      "dropThinkingBlocks",
    );
  });

  it("builds native Anthropic replay policy with selective tool-call id preservation", () => {
    expect(buildNativeAnthropicReplayPolicyForModel("claude-sonnet-4-6")).toMatchObject({
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      preserveNativeAnthropicToolUseIds: true,
      preserveSignatures: true,
      repairToolUseResultPairing: true,
      validateAnthropicTurns: true,
      allowSyntheticToolResults: true,
      dropThinkingBlocks: true,
    });
  });

  it("builds hybrid anthropic or openai replay policy", () => {
    expect(
      buildHybridAnthropicOrOpenAIReplayPolicy(
        {
          provider: "minimax",
          modelApi: "anthropic-messages",
          modelId: "claude-sonnet-4-6",
        } as never,
        { anthropicModelDropThinkingBlocks: true },
      ),
    ).toMatchObject({
      validateAnthropicTurns: true,
      dropThinkingBlocks: true,
    });

    expect(
      buildHybridAnthropicOrOpenAIReplayPolicy({
        provider: "minimax",
        modelApi: "openai-completions",
        modelId: "MiniMax-M2.7",
      } as never),
    ).toMatchObject({
      sanitizeToolCallIds: true,
      applyAssistantFirstOrderingFix: true,
    });
  });

  it("builds Gemini replay helpers and tagged reasoning mode", () => {
    expect(buildGoogleGeminiReplayPolicy()).toMatchObject({
      validateGeminiTurns: true,
      allowSyntheticToolResults: true,
    });
    expect(resolveTaggedReasoningOutputMode()).toBe("tagged");
  });

  it("builds passthrough Gemini signature sanitization only when needed", () => {
    expect(buildPassthroughGeminiSanitizingReplayPolicy("gemini-2.5-pro")).toMatchObject({
      applyAssistantFirstOrderingFix: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
      sanitizeThoughtSignatures: {
        allowBase64Only: true,
        includeCamelCase: true,
      },
    });
    expect(
      buildPassthroughGeminiSanitizingReplayPolicy("anthropic/claude-sonnet-4-6"),
    ).not.toHaveProperty("sanitizeThoughtSignatures");
  });

  it("sanitizes Gemini replay ordering with a bootstrap turn", () => {
    const customEntries: Array<{ customType: string; data: unknown }> = [];

    const result = sanitizeGoogleGeminiReplayHistory({
      provider: "google",
      modelApi: "google-generative-ai",
      modelId: "gemini-3.1-pro-preview",
      sessionId: "session-1",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
      ],
      sessionState: {
        getCustomEntries: () => customEntries,
        appendCustomEntry: (customType: string, data: unknown) => {
          customEntries.push({ customType, data });
        },
      },
    } as never);

    expect(result[0]).toMatchObject({
      role: "user",
      content: "(session bootstrap)",
    });
    expect(customEntries[0]?.customType).toBe("google-turn-ordering-bootstrap");
  });
});
