import { describe, expect, it } from "vitest";
import { resolveTranscriptPolicy } from "./transcript-policy.js";

describe("resolveTranscriptPolicy", () => {
  describe("copilot + gemini fixes", () => {
    it("enables repairToolUseResultPairing for copilot + gemini", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "openai-completions",
        provider: "github-copilot",
        modelId: "gemini-3-flash-preview",
      });
      expect(policy.repairToolUseResultPairing).toBe(true);
      expect(policy.allowSyntheticToolResults).toBe(true);
      expect(policy.splitParallelToolCalls).toBe(true);
    });

    it("enables repairToolUseResultPairing for copilot + gemini-2.5-pro", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "openai-completions",
        provider: "github-copilot",
        modelId: "gemini-2.5-pro",
      });
      expect(policy.repairToolUseResultPairing).toBe(true);
      expect(policy.allowSyntheticToolResults).toBe(true);
      expect(policy.splitParallelToolCalls).toBe(true);
    });

    it("does not enable for copilot + non-gemini model", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "openai-responses",
        provider: "github-copilot",
        modelId: "gpt-4o",
      });
      expect(policy.repairToolUseResultPairing).toBe(false);
      expect(policy.splitParallelToolCalls).toBe(false);
    });

    it("does not enable for openai provider", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "openai-responses",
        provider: "openai",
        modelId: "gpt-4o",
      });
      expect(policy.repairToolUseResultPairing).toBe(false);
      expect(policy.splitParallelToolCalls).toBe(false);
    });

    it("does not enable for direct google api (has own handling)", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "google-generative-ai",
        provider: "google-generative-ai",
        modelId: "gemini-3-flash-preview",
      });
      // isGoogle handles this natively, not via isCopilotGemini
      expect(policy.repairToolUseResultPairing).toBe(true);
    });

    it("does not enable for openrouter + gemini (has own handling)", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "openai-completions",
        provider: "openrouter",
        modelId: "google/gemini-2.5-pro",
      });
      expect(policy.repairToolUseResultPairing).toBe(false);
    });
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
  });
});
