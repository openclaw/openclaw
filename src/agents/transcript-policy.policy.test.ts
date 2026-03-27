import { describe, expect, it } from "vitest";
import { resolveTranscriptPolicy } from "./transcript-policy.js";

describe("resolveTranscriptPolicy e2e smoke", () => {
  it("uses images-only sanitization without tool-call id rewriting for OpenAI models", () => {
    const policy = resolveTranscriptPolicy({
      provider: "openai",
      modelId: "gpt-4o",
      modelApi: "openai",
    });
    expect(policy.sanitizeMode).toBe("images-only");
    expect(policy.sanitizeToolCallIds).toBe(false);
    expect(policy.toolCallIdMode).toBeUndefined();
  });

  it("enables validateAnthropicTurns for all openai-completions providers", () => {
    const policy = resolveTranscriptPolicy({
      provider: "openrouter",
      modelId: "deepseek-chat",
      modelApi: "openai-completions",
    });
    expect(policy.validateAnthropicTurns).toBe(true);
  });

  it("enables validateAnthropicTurns for openai-completions with a non-strict provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "opencode",
      modelId: "deepseek-chat",
      modelApi: "openai-completions",
    });
    expect(policy.validateAnthropicTurns).toBe(true);
  });

  it("uses strict9 tool-call sanitization for Mistral-family models", () => {
    const policy = resolveTranscriptPolicy({
      provider: "mistral",
      modelId: "mistral-large-latest",
    });
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict9");
  });
});
