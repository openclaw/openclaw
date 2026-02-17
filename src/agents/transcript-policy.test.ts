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

  it("enables normalizeAntigravityThinkingBlocks for Antigravity Claude models", () => {
    const policy = resolveTranscriptPolicy({
      provider: "google-antigravity",
      modelId: "anthropic/claude-opus-4-6",
      modelApi: "google-antigravity",
    });
    expect(policy.normalizeAntigravityThinkingBlocks).toBe(true);
    expect(policy.preserveSignatures).toBe(true);
  });

  it("does not enable normalizeAntigravityThinkingBlocks for Gemini via Antigravity", () => {
    const policy = resolveTranscriptPolicy({
      provider: "google-antigravity",
      modelId: "google/gemini-2.0-flash",
      modelApi: "google-antigravity",
    });
    expect(policy.normalizeAntigravityThinkingBlocks).toBe(false);
  });

  it("does not enable normalizeAntigravityThinkingBlocks for direct Anthropic API", () => {
    const policy = resolveTranscriptPolicy({
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      modelApi: "anthropic-messages",
    });
    expect(policy.normalizeAntigravityThinkingBlocks).toBe(false);
  });
});
