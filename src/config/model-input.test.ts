import { describe, it, expect } from "vitest";
import { normalizeAgentModelRefForConfig } from "./model-input.js";

describe("normalizeAgentModelRefForConfig", () => {
  describe("Google providers", () => {
    it("should normalize preview model IDs for google provider", () => {
      const result = normalizeAgentModelRefForConfig("google/gemini-2.0-flash");
      expect(result).toBeTruthy();
      expect(typeof result).toBe("string");
    });

    it("should normalize preview model IDs for google-gemini-cli provider", () => {
      const result = normalizeAgentModelRefForConfig("google-gemini-cli/gemini-2.0-flash");
      expect(result).toBeTruthy();
      expect(typeof result).toBe("string");
    });

    it("should normalize preview model IDs for google-vertex provider", () => {
      const result = normalizeAgentModelRefForConfig("google-vertex/gemini-2.0-flash");
      expect(result).toBeTruthy();
      expect(typeof result).toBe("string");
    });
  });

  describe("Non-Google providers", () => {
    it("should NOT normalize model IDs for litellm provider", () => {
      const result = normalizeAgentModelRefForConfig("litellm/gemini-2.0-flash");
      expect(result).toBe("litellm/gemini-2.0-flash");
    });

    it("should NOT normalize model IDs for openai provider", () => {
      const result = normalizeAgentModelRefForConfig("openai/gpt-4");
      expect(result).toBe("openai/gpt-4");
    });

    it("should NOT normalize model IDs for anthropic provider", () => {
      const result = normalizeAgentModelRefForConfig("anthropic/claude-3-5-sonnet");
      expect(result).toBe("anthropic/claude-3-5-sonnet");
    });

    it("should NOT normalize model IDs for opencode-go provider", () => {
      const result = normalizeAgentModelRefForConfig("opencode-go/kimi-k2.6");
      expect(result).toBe("opencode-go/kimi-k2.6");
    });
  });

  describe("Edge cases", () => {
    it("should return trimmed input when no provider prefix", () => {
      const result = normalizeAgentModelRefForConfig("  gemini-2.0-flash  ");
      expect(result).toBe("gemini-2.0-flash");
    });

    it("should handle empty string", () => {
      const result = normalizeAgentModelRefForConfig("");
      expect(result).toBe("");
    });

    it("should handle model without slash", () => {
      const result = normalizeAgentModelRefForConfig("gpt-4");
      expect(result).toBe("gpt-4");
    });
  });
});
