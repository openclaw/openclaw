import { describe, expect, it, vi } from "vitest";
import {
  getDefaultCopilotModelIds,
  buildCopilotModelDefinition,
  discoverCopilotModels,
} from "./github-copilot-models.js";

// Mock the SDK discovery so we can test both paths
vi.mock("./github-copilot-sdk.js", () => ({
  discoverCopilotModelsViaSdk: vi.fn().mockResolvedValue(null),
}));

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

  describe("discoverCopilotModels", () => {
    it("falls back to hardcoded defaults when SDK returns null", async () => {
      const { discoverCopilotModelsViaSdk } = await import("./github-copilot-sdk.js");
      vi.mocked(discoverCopilotModelsViaSdk).mockResolvedValue(null);

      const models = await discoverCopilotModels();
      expect(models.length).toBeGreaterThan(0);
      // Should match hardcoded defaults
      const ids = models.map((m) => m.id);
      expect(ids).toContain("gpt-4o");
      expect(ids).toContain("claude-sonnet-4");
    });

    it("uses SDK models when available", async () => {
      const { discoverCopilotModelsViaSdk } = await import("./github-copilot-sdk.js");
      vi.mocked(discoverCopilotModelsViaSdk).mockResolvedValue([
        {
          id: "sdk-model-1",
          name: "SDK Model 1",
          api: "openai-responses",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 64000,
          maxTokens: 4096,
        },
      ]);

      const models = await discoverCopilotModels();
      expect(models.length).toBe(1);
      expect(models[0]).toBeDefined();
      expect(models[0]?.id).toBe("sdk-model-1");
    });

    it("falls back when SDK returns empty array", async () => {
      const { discoverCopilotModelsViaSdk } = await import("./github-copilot-sdk.js");
      vi.mocked(discoverCopilotModelsViaSdk).mockResolvedValue([]);

      const models = await discoverCopilotModels();
      // Should fall back to defaults since SDK returned empty
      const defaults = getDefaultCopilotModelIds();
      expect(models.length).toBe(defaults.length);
    });
  });
});
