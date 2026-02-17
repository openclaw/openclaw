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

  it("enables repairToolUseResultPairing for direct MiniMax provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "minimax",
      modelId: "MiniMax-M2.5",
      modelApi: "anthropic-messages",
    });
    expect(policy.repairToolUseResultPairing).toBe(true);
    expect(policy.allowSyntheticToolResults).toBe(true);
  });

  it("enables repairToolUseResultPairing for MiniMax model behind a proxy", () => {
    const policy = resolveTranscriptPolicy({
      provider: "unleashed-openai",
      modelId: "minimax-m2.5-free",
      modelApi: "openai-responses",
    });
    expect(policy.repairToolUseResultPairing).toBe(true);
    expect(policy.allowSyntheticToolResults).toBe(true);
  });

  it("enables repairToolUseResultPairing for MiniMax-CN provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "minimax-cn",
      modelId: "MiniMax-M2.5",
    });
    expect(policy.repairToolUseResultPairing).toBe(true);
    expect(policy.allowSyntheticToolResults).toBe(true);
  });
});
