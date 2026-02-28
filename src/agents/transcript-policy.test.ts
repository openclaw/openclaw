import { describe, expect, it } from "vitest";
import { resolveTranscriptPolicy } from "./transcript-policy.js";

describe("resolveTranscriptPolicy", () => {
  it("enables sanitizeToolCallIds for Anthropic provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "anthropic",
      modelId: "claude-opus-4-5",
      modelApi: "anthropic-messages",
    });
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict");
  });

  it("enables sanitizeToolCallIds for Google provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "google",
      modelId: "gemini-2.0-flash",
      modelApi: "google-generative-ai",
    });
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.sanitizeThoughtSignatures).toEqual({
      allowBase64Only: true,
      includeCamelCase: true,
    });
  });

  it("enables sanitizeToolCallIds for Mistral provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "mistral",
      modelId: "mistral-large-latest",
    });
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict9");
  });

  it("disables sanitizeToolCallIds for OpenAI provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "openai",
      modelId: "gpt-4o",
      modelApi: "openai",
    });
    expect(policy.sanitizeToolCallIds).toBe(false);
    expect(policy.toolCallIdMode).toBeUndefined();
  });

  it("enables user-turn merge for strict OpenAI-compatible providers", () => {
    const policy = resolveTranscriptPolicy({
      provider: "moonshot",
      modelId: "kimi-k2.5",
      modelApi: "openai-completions",
    });
    expect(policy.validateAnthropicTurns).toBe(true);
  });

  it("enables Anthropic-compatible policies for Bedrock provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "amazon-bedrock",
      modelId: "us.anthropic.claude-opus-4-6-v1",
      modelApi: "bedrock-converse-stream",
    });
    expect(policy.repairToolUseResultPairing).toBe(true);
    expect(policy.validateAnthropicTurns).toBe(true);
    expect(policy.allowSyntheticToolResults).toBe(true);
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.sanitizeMode).toBe("full");
  });

  it("keeps OpenRouter on its existing turn-validation path", () => {
    const policy = resolveTranscriptPolicy({
      provider: "openrouter",
      modelId: "openai/gpt-4.1",
      modelApi: "openai-completions",
    });
    expect(policy.validateAnthropicTurns).toBe(false);
  });
});
