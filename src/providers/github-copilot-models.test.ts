import { describe, expect, it } from "vitest";
import { getDefaultCopilotModelIds, buildCopilotModelDefinition } from "./github-copilot-models.js";

describe("github-copilot-models", () => {
  describe("getDefaultCopilotModelIds", () => {
    it("returns a non-empty list of model ids", () => {
      const ids = getDefaultCopilotModelIds();
      expect(ids.length).toBeGreaterThan(0);
    });

    it("includes key models", () => {
      const ids = getDefaultCopilotModelIds();
      expect(ids).toContain("gpt-4o");
      expect(ids).toContain("claude-sonnet-4");
      expect(ids).toContain("claude-opus-4.6-fast");
      expect(ids).toContain("o3-mini");
      expect(ids).toContain("gemini-3-pro-preview");
    });

    it("returns a fresh copy each time", () => {
      const a = getDefaultCopilotModelIds();
      const b = getDefaultCopilotModelIds();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe("buildCopilotModelDefinition", () => {
    it("builds a valid model definition", () => {
      const def = buildCopilotModelDefinition("gpt-4o");
      expect(def.id).toBe("gpt-4o");
      expect(def.api).toBe("openai-responses");
      expect(def.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(def.contextWindow).toBe(128_000);
    });

    it("uses anthropic-messages API for Claude models", () => {
      expect(buildCopilotModelDefinition("claude-sonnet-4").api).toBe("anthropic-messages");
      expect(buildCopilotModelDefinition("claude-opus-4.6-fast").api).toBe("anthropic-messages");
      expect(buildCopilotModelDefinition("claude-haiku-4.5").api).toBe("anthropic-messages");
    });

    it("uses openai-responses API for non-Claude models", () => {
      expect(buildCopilotModelDefinition("gpt-4o").api).toBe("openai-responses");
      expect(buildCopilotModelDefinition("o3-mini").api).toBe("openai-responses");
      expect(buildCopilotModelDefinition("gemini-3-pro-preview").api).toBe("openai-responses");
    });

    it("throws on empty model id", () => {
      expect(() => buildCopilotModelDefinition("")).toThrow("Model id required");
      expect(() => buildCopilotModelDefinition("  ")).toThrow("Model id required");
    });

    it("marks reasoning models correctly", () => {
      expect(buildCopilotModelDefinition("o1").reasoning).toBe(true);
      expect(buildCopilotModelDefinition("o3-mini").reasoning).toBe(true);
      expect(buildCopilotModelDefinition("claude-opus-4.5").reasoning).toBe(true);
      expect(buildCopilotModelDefinition("claude-opus-4.6-fast").reasoning).toBe(true);
      expect(buildCopilotModelDefinition("gpt-4o").reasoning).toBe(false);
      expect(buildCopilotModelDefinition("gpt-4.1-nano").reasoning).toBe(false);
    });

    it("marks vision models correctly", () => {
      expect(buildCopilotModelDefinition("gpt-4o").input).toEqual(["text", "image"]);
      expect(buildCopilotModelDefinition("claude-sonnet-4.5").input).toEqual(["text", "image"]);
      expect(buildCopilotModelDefinition("gemini-3-pro-preview").input).toEqual(["text", "image"]);
      expect(buildCopilotModelDefinition("o3-mini").input).toEqual(["text"]);
    });

    it("handles unknown models gracefully", () => {
      const def = buildCopilotModelDefinition("future-model-xyz");
      expect(def.reasoning).toBe(false);
      expect(def.input).toEqual(["text"]);
    });
  });
});
