import { describe, expect, it } from "vitest";
import { resolveTranscriptPolicy } from "./transcript-policy.js";

describe("resolveTranscriptPolicy", () => {
  describe("sanitizeToolCallIds", () => {
    it("enables for Anthropic provider", () => {
      const policy = resolveTranscriptPolicy({
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });
      expect(policy.sanitizeToolCallIds).toBe(true);
    });

    it("enables for Google modelApi", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "google-generative-ai",
        modelId: "gemini-2.0-flash",
      });
      expect(policy.sanitizeToolCallIds).toBe(true);
    });

    it("enables for Mistral provider", () => {
      const policy = resolveTranscriptPolicy({ provider: "mistral", modelId: "mistral-large" });
      expect(policy.sanitizeToolCallIds).toBe(true);
    });

    it("disables for OpenAI provider", () => {
      const policy = resolveTranscriptPolicy({ provider: "openai", modelId: "gpt-4o" });
      expect(policy.sanitizeToolCallIds).toBe(false);
    });

    it("enables for Anthropic via modelApi", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-5",
      });
      expect(policy.sanitizeToolCallIds).toBe(true);
    });
  });

  describe("toolCallIdMode", () => {
    it("returns strict for Anthropic", () => {
      const policy = resolveTranscriptPolicy({
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });
      expect(policy.toolCallIdMode).toBe("strict");
    });

    it("returns strict9 for Mistral", () => {
      const policy = resolveTranscriptPolicy({ provider: "mistral", modelId: "mistral-large" });
      expect(policy.toolCallIdMode).toBe("strict9");
    });

    it("returns strict for Google modelApi", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "google-generative-ai",
        modelId: "gemini-2.0-flash",
      });
      expect(policy.toolCallIdMode).toBe("strict");
    });

    it("returns undefined for OpenAI", () => {
      const policy = resolveTranscriptPolicy({ provider: "openai", modelId: "gpt-4o" });
      expect(policy.toolCallIdMode).toBeUndefined();
    });
  });
});
