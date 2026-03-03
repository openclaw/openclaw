import { describe, expect, it } from "vitest";
import { resolveTranscriptPolicy } from "./transcript-policy.js";

describe("resolveTranscriptPolicy", () => {
  describe("Mistral models", () => {
    it("enables repairToolUseResultPairing for mistral provider", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "openai-completions",
        provider: "mistral",
        modelId: "devstral-2512",
      });
      expect(policy.repairToolUseResultPairing).toBe(true);
    });

    it("enables repairToolUseResultPairing for mistralai model hints", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "openai-completions",
        provider: "openrouter",
        modelId: "mistralai/devstral-small-2505",
      });
      expect(policy.repairToolUseResultPairing).toBe(true);
    });

    it("enables repairToolUseResultPairing for codestral model", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "openai-completions",
        provider: "openrouter",
        modelId: "codestral-latest",
      });
      expect(policy.repairToolUseResultPairing).toBe(true);
    });

    it("sanitizes tool call ids for mistral", () => {
      const policy = resolveTranscriptPolicy({
        provider: "mistral",
        modelId: "devstral-2512",
      });
      expect(policy.sanitizeToolCallIds).toBe(true);
      expect(policy.toolCallIdMode).toBe("strict9");
    });
  });

  describe("Anthropic models", () => {
    it("enables repairToolUseResultPairing for anthropic", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "anthropic-messages",
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
      });
      expect(policy.repairToolUseResultPairing).toBe(true);
    });
  });

  describe("Google models", () => {
    it("enables repairToolUseResultPairing for google", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "google-genai",
        provider: "google",
        modelId: "gemini-2.5-pro",
      });
      expect(policy.repairToolUseResultPairing).toBe(true);
    });
  });

  describe("OpenAI models", () => {
    it("disables repairToolUseResultPairing for openai", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "openai-completions",
        provider: "openai",
        modelId: "gpt-4o",
      });
      expect(policy.repairToolUseResultPairing).toBe(false);
    });
  });
});
