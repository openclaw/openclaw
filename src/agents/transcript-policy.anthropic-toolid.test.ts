import { describe, expect, it } from "vitest";
import { resolveTranscriptPolicy } from "./transcript-policy.js";

describe("resolveTranscriptPolicy for Anthropic", () => {
  it("enables tool call ID sanitization for Anthropic models", () => {
    const policy = resolveTranscriptPolicy({
      modelApi: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-opus-4-6",
    });

    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("anthropic");
  });

  it("uses anthropic mode which allows underscores and hyphens", () => {
    const policy = resolveTranscriptPolicy({
      modelApi: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-opus-4-5",
    });

    // Anthropic mode should be used (allows [a-zA-Z0-9_-])
    expect(policy.toolCallIdMode).toBe("anthropic");
  });

  it("uses strict9 mode for Mistral models", () => {
    const policy = resolveTranscriptPolicy({
      modelApi: "openai-completions",
      provider: "mistral",
      modelId: "mistral-large",
    });

    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict9");
  });

  it("uses strict mode for Google models", () => {
    const policy = resolveTranscriptPolicy({
      modelApi: "google-generative-ai",
      provider: "google",
      modelId: "gemini-3-pro",
    });

    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict");
  });

  it("does not sanitize tool call IDs for OpenAI models", () => {
    const policy = resolveTranscriptPolicy({
      modelApi: "openai-responses",
      provider: "openai",
      modelId: "gpt-5.2",
    });

    expect(policy.sanitizeToolCallIds).toBe(false);
    expect(policy.toolCallIdMode).toBeUndefined();
  });
});
