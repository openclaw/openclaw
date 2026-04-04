import { describe, expect, it } from "vitest";
import { buildProviderReplayFamilyHooks } from "./provider-model-shared.js";

describe("buildProviderReplayFamilyHooks", () => {
  it("maps openai-compatible replay families", () => {
    const hooks = buildProviderReplayFamilyHooks({
      family: "openai-compatible",
    });

    expect(
      hooks.buildReplayPolicy?.({
        provider: "xai",
        modelApi: "openai-completions",
        modelId: "grok-4",
      } as never),
    ).toMatchObject({
      sanitizeToolCallIds: true,
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
    });
  });

  it("maps google-gemini replay families", async () => {
    const hooks = buildProviderReplayFamilyHooks({
      family: "google-gemini",
    });

    expect(hooks.resolveReasoningOutputMode?.({} as never)).toBe("tagged");
    expect(
      hooks.buildReplayPolicy?.({
        provider: "google",
        modelApi: "google-generative-ai",
        modelId: "gemini-3.1-pro-preview",
      } as never),
    ).toMatchObject({
      validateGeminiTurns: true,
      allowSyntheticToolResults: true,
    });

    const sanitized = await hooks.sanitizeReplayHistory?.({
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
        getCustomEntries: () => [],
        appendCustomEntry: () => {},
      },
    } as never);

    expect(sanitized?.[0]).toMatchObject({
      role: "user",
      content: "(session bootstrap)",
    });
  });

  it("maps hybrid anthropic/openai replay families", () => {
    const hooks = buildProviderReplayFamilyHooks({
      family: "hybrid-anthropic-openai",
      anthropicModelDropThinkingBlocks: true,
    });

    expect(
      hooks.buildReplayPolicy?.({
        provider: "minimax",
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      } as never),
    ).toMatchObject({
      validateAnthropicTurns: true,
      dropThinkingBlocks: true,
    });
  });
});
