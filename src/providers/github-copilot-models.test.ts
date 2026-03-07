import { describe, expect, it } from "vitest";
import {
  COPILOT_GPT_54_CONTEXT_WINDOW,
  COPILOT_GPT_54_MAX_TOKENS,
} from "./github-copilot-constants.js";
import { buildCopilotModelDefinition, getDefaultCopilotModelIds } from "./github-copilot-models.js";

describe("github-copilot-models", () => {
  describe("getDefaultCopilotModelIds", () => {
    it("includes claude-sonnet-4.6", () => {
      expect(getDefaultCopilotModelIds()).toContain("claude-sonnet-4.6");
    });

    it("includes claude-sonnet-4.5", () => {
      expect(getDefaultCopilotModelIds()).toContain("claude-sonnet-4.5");
    });

    it("includes gpt-5.4", () => {
      expect(getDefaultCopilotModelIds()).toContain("gpt-5.4");
    });

    it("returns a mutable copy", () => {
      const a = getDefaultCopilotModelIds();
      const b = getDefaultCopilotModelIds();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe("buildCopilotModelDefinition", () => {
    it("builds a valid definition for claude-sonnet-4.6", () => {
      const def = buildCopilotModelDefinition("claude-sonnet-4.6");
      expect(def.id).toBe("claude-sonnet-4.6");
      expect(def.api).toBe("openai-responses");
    });

    it("applies GPT-5.4 metadata overrides", () => {
      const def = buildCopilotModelDefinition("gpt-5.4");
      expect(def.reasoning).toBe(true);
      expect(def.contextWindow).toBe(COPILOT_GPT_54_CONTEXT_WINDOW);
      expect(def.maxTokens).toBe(COPILOT_GPT_54_MAX_TOKENS);
    });

    it("trims whitespace from model id", () => {
      const def = buildCopilotModelDefinition("  gpt-4o  ");
      expect(def.id).toBe("gpt-4o");
    });

    it("throws on empty model id", () => {
      expect(() => buildCopilotModelDefinition("")).toThrow("Model id required");
      expect(() => buildCopilotModelDefinition("  ")).toThrow("Model id required");
    });
  });
});
