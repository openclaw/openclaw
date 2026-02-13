import { describe, it, expect } from "vitest";
import {
  normalizeProviderId,
  normalizeModelId,
  parseModelRef,
  formatModelRef,
  modelKey,
  isProviderMatch,
} from "./normalization.js";

describe("normalization", () => {
  describe("normalizeProviderId", () => {
    it("normalizes known aliases", () => {
      expect(normalizeProviderId("z-ai")).toBe("zai");
      expect(normalizeProviderId("z.ai")).toBe("zai");
      expect(normalizeProviderId("Claude")).toBe("anthropic");
      expect(normalizeProviderId("Gemini")).toBe("google");
      expect(normalizeProviderId("opencode-zen")).toBe("opencode");
    });

    it("handles case variations", () => {
      expect(normalizeProviderId("ANTHROPIC")).toBe("anthropic");
      expect(normalizeProviderId("OpenAI")).toBe("openai");
    });

    it("preserves unknown providers", () => {
      expect(normalizeProviderId("custom-provider")).toBe("custom-provider");
    });

    it("handles empty strings", () => {
      expect(normalizeProviderId("")).toBe("");
      expect(normalizeProviderId("  ")).toBe("");
    });
  });

  describe("normalizeModelId", () => {
    it("normalizes Anthropic model IDs", () => {
      expect(normalizeModelId("anthropic", "opus-4.6")).toBe("claude-opus-4-6");
      expect(normalizeModelId("anthropic", "sonnet-4.5")).toBe("claude-sonnet-4-5");
      expect(normalizeModelId("anthropic", "haiku-4.5")).toBe("claude-haiku-4-5");
    });

    it("preserves already-normalized Anthropic models", () => {
      expect(normalizeModelId("anthropic", "claude-opus-4-6")).toBe("claude-opus-4-6");
    });

    it("handles Google model IDs", () => {
      expect(normalizeModelId("google", "models/gemini-2.0-flash")).toBe("gemini-2.0-flash");
      expect(normalizeModelId("google", "gemini-2.0-flash")).toBe("gemini-2.0-flash");
    });

    it("preserves model IDs for other providers", () => {
      expect(normalizeModelId("openai", "gpt-4")).toBe("gpt-4");
      expect(normalizeModelId("custom", "my-model")).toBe("my-model");
    });
  });

  describe("parseModelRef", () => {
    it("parses provider/model format", () => {
      const ref = parseModelRef("anthropic/claude-opus-4-6");
      expect(ref).toEqual({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
    });

    it("parses provider/model@account format", () => {
      const ref = parseModelRef("anthropic/opus@prod");
      expect(ref).toEqual({
        provider: "anthropic",
        model: "claude-opus-4-6",
        accountTag: "prod",
      });
    });

    it("uses default provider when not specified", () => {
      const ref = parseModelRef("opus-4.6", "anthropic");
      expect(ref).toEqual({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
    });

    it("handles aliases in provider names", () => {
      const ref = parseModelRef("claude/opus-4.6");
      expect(ref).toEqual({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
    });

    it("returns null for empty strings", () => {
      expect(parseModelRef("")).toBeNull();
      expect(parseModelRef("  ")).toBeNull();
    });

    it("returns null for invalid formats", () => {
      expect(parseModelRef("/model")).toBeNull();
      expect(parseModelRef("provider/")).toBeNull();
    });
  });

  describe("formatModelRef", () => {
    it("formats basic provider/model", () => {
      expect(formatModelRef("anthropic", "claude-opus-4-6")).toBe("anthropic/claude-opus-4-6");
    });

    it("formats with account tag", () => {
      expect(formatModelRef("anthropic", "opus", "prod")).toBe("anthropic/opus@prod");
    });

    it("normalizes provider ID", () => {
      expect(formatModelRef("Claude", "opus")).toBe("anthropic/opus");
    });
  });

  describe("modelKey", () => {
    it("creates unique keys", () => {
      expect(modelKey("anthropic", "opus")).toBe("anthropic/opus");
      expect(modelKey("openai", "gpt-4")).toBe("openai/gpt-4");
    });

    it("normalizes provider in key", () => {
      expect(modelKey("Claude", "opus")).toBe("anthropic/opus");
    });
  });

  describe("isProviderMatch", () => {
    it("matches normalized providers", () => {
      expect(isProviderMatch("anthropic", "anthropic")).toBe(true);
      expect(isProviderMatch("Claude", "anthropic")).toBe(true);
      expect(isProviderMatch("z-ai", "zai")).toBe(true);
    });

    it("handles multiple targets", () => {
      expect(isProviderMatch("claude", "anthropic", "openai")).toBe(true);
      expect(isProviderMatch("gemini", "google", "anthropic")).toBe(true);
    });

    it("returns false for non-matching providers", () => {
      expect(isProviderMatch("anthropic", "openai")).toBe(false);
      expect(isProviderMatch("custom", "anthropic", "openai")).toBe(false);
    });
  });
});
