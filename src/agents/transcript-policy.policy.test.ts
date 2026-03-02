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

  it("uses strict tool-call id rewriting for OpenAI-compatible chat-completions models", () => {
    const policy = resolveTranscriptPolicy({
      provider: "openai",
      modelId: "gpt-5.2",
      modelApi: "openai-completions",
    });
    expect(policy.sanitizeMode).toBe("images-only");
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict");
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
