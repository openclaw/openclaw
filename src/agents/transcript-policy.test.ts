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

  it("enables stripCompletionsReasoningFieldSignatures for Copilot openai-completions", () => {
    const policy = resolveTranscriptPolicy({
      provider: "github-copilot",
      modelId: "claude-opus-4.6-fast",
      modelApi: "openai-completions",
    });
    expect(policy.stripCompletionsReasoningFieldSignatures).toBe(true);
  });

  it("enables repairToolUseResultPairing for Copilot provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "github-copilot",
      modelId: "claude-opus-4.6-fast",
      modelApi: "openai-completions",
    });
    expect(policy.repairToolUseResultPairing).toBe(true);
  });

  it("enables stripCompletionsReasoningFieldSignatures for Copilot openai-responses", () => {
    const policy = resolveTranscriptPolicy({
      provider: "github-copilot",
      modelId: "claude-opus-4.6-fast",
      modelApi: "openai-responses",
    });
    expect(policy.stripCompletionsReasoningFieldSignatures).toBe(true);
  });

  it("disables stripCompletionsReasoningFieldSignatures for native OpenAI provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "openai",
      modelId: "gpt-4o",
      modelApi: "openai-completions",
    });
    expect(policy.stripCompletionsReasoningFieldSignatures).toBe(false);
  });

  it("disables stripCompletionsReasoningFieldSignatures for Anthropic provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "anthropic",
      modelId: "claude-opus-4-5",
      modelApi: "anthropic-messages",
    });
    expect(policy.stripCompletionsReasoningFieldSignatures).toBe(false);
  });
});
