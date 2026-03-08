import { describe, expect, it } from "vitest";
import { buildCopilotModelDefinition, getDefaultCopilotModelIds } from "./github-copilot-models.js";

describe("github-copilot-models", () => {
  describe("getDefaultCopilotModelIds", () => {
    it("includes claude-sonnet-4.6", () => {
      expect(getDefaultCopilotModelIds()).toContain("claude-sonnet-4.6");
    });

    it("includes claude-sonnet-4.5", () => {
      expect(getDefaultCopilotModelIds()).toContain("claude-sonnet-4.5");
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
      expect(def.api).toBe("anthropic-messages");
    });

    it("trims whitespace from model id", () => {
      const def = buildCopilotModelDefinition("  gpt-4o  ");
      expect(def.id).toBe("gpt-4o");
    });

    it("throws on empty model id", () => {
      expect(() => buildCopilotModelDefinition("")).toThrow("Model id required");
      expect(() => buildCopilotModelDefinition("  ")).toThrow("Model id required");
    });

    it("claude-opus-4.6 uses anthropic-messages and 128k context", () => {
      const def = buildCopilotModelDefinition("claude-opus-4.6");
      expect(def.api).toBe("anthropic-messages");
      expect(def.contextWindow).toBe(128_000);
      expect(def.reasoning).toBe(true);
    });

    it("claude-sonnet-4.5 uses anthropic-messages and 128k context", () => {
      const def = buildCopilotModelDefinition("claude-sonnet-4.5");
      expect(def.api).toBe("anthropic-messages");
      expect(def.contextWindow).toBe(128_000);
    });

    it("gpt-5.3-codex uses openai-responses and 128k context", () => {
      const def = buildCopilotModelDefinition("gpt-5.3-codex");
      expect(def.api).toBe("openai-responses");
      expect(def.contextWindow).toBe(128_000);
    });

    it("gpt-5.2-codex uses openai-responses and 128k context", () => {
      const def = buildCopilotModelDefinition("gpt-5.2-codex");
      expect(def.api).toBe("openai-responses");
      expect(def.contextWindow).toBe(128_000);
    });

    it("unknown model defaults to openai-completions and 128k context", () => {
      const def = buildCopilotModelDefinition("gpt-4.1");
      expect(def.api).toBe("openai-completions");
      expect(def.contextWindow).toBe(128_000);
      expect(def.reasoning).toBe(false);
    });

    it("model id lookup is case-insensitive", () => {
      const def = buildCopilotModelDefinition("Claude-Opus-4.6");
      expect(def.api).toBe("anthropic-messages");
      expect(def.contextWindow).toBe(128_000);
      // id preserves original casing
      expect(def.id).toBe("Claude-Opus-4.6");
    });
  });
});
