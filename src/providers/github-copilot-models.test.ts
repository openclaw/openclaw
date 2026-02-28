import { describe, expect, it } from "vitest";
import {
  buildCopilotModelDefinition,
  getDefaultCopilotModelIds,
  resolveCopilotModelApi,
} from "./github-copilot-models.js";

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

  describe("resolveCopilotModelApi", () => {
    it("resolves Claude models to anthropic-messages", () => {
      expect(resolveCopilotModelApi("claude-sonnet-4.6")).toBe("anthropic-messages");
      expect(resolveCopilotModelApi("claude-opus-4.6")).toBe("anthropic-messages");
      expect(resolveCopilotModelApi("claude-haiku-4.5")).toBe("anthropic-messages");
      expect(resolveCopilotModelApi("claude-sonnet-4.5")).toBe("anthropic-messages");
      expect(resolveCopilotModelApi("Claude-Opus-4.5")).toBe("anthropic-messages");
    });

    it("resolves GPT-5.x models to openai-responses", () => {
      expect(resolveCopilotModelApi("gpt-5")).toBe("openai-responses");
      expect(resolveCopilotModelApi("gpt-5.1")).toBe("openai-responses");
      expect(resolveCopilotModelApi("gpt-5.2")).toBe("openai-responses");
      expect(resolveCopilotModelApi("gpt-5-mini")).toBe("openai-responses");
    });

    it("resolves codex models to openai-responses", () => {
      expect(resolveCopilotModelApi("gpt-5.1-codex")).toBe("openai-responses");
      expect(resolveCopilotModelApi("gpt-5.2-codex")).toBe("openai-responses");
    });

    it("resolves GPT-4.x models to openai-completions", () => {
      expect(resolveCopilotModelApi("gpt-4o")).toBe("openai-completions");
      expect(resolveCopilotModelApi("gpt-4.1")).toBe("openai-completions");
      expect(resolveCopilotModelApi("gpt-4.1-mini")).toBe("openai-completions");
    });

    it("resolves Gemini models to openai-completions", () => {
      expect(resolveCopilotModelApi("gemini-2.5-pro")).toBe("openai-completions");
      expect(resolveCopilotModelApi("gemini-3-pro-preview")).toBe("openai-completions");
    });

    it("resolves Grok models to openai-completions", () => {
      expect(resolveCopilotModelApi("grok-code-fast-1")).toBe("openai-completions");
    });

    it("resolves o-series models to openai-completions", () => {
      expect(resolveCopilotModelApi("o1")).toBe("openai-completions");
      expect(resolveCopilotModelApi("o3-mini")).toBe("openai-completions");
    });
  });

  describe("buildCopilotModelDefinition", () => {
    it("builds a valid definition for claude-sonnet-4.6 with anthropic-messages api", () => {
      const def = buildCopilotModelDefinition("claude-sonnet-4.6");
      expect(def.id).toBe("claude-sonnet-4.6");
      expect(def.api).toBe("anthropic-messages");
    });

    it("builds a valid definition for gpt-4o with openai-completions api", () => {
      const def = buildCopilotModelDefinition("gpt-4o");
      expect(def.id).toBe("gpt-4o");
      expect(def.api).toBe("openai-completions");
    });

    it("builds a valid definition for gpt-5 with openai-responses api", () => {
      const def = buildCopilotModelDefinition("gpt-5");
      expect(def.id).toBe("gpt-5");
      expect(def.api).toBe("openai-responses");
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
