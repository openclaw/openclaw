import { describe, expect, it } from "vitest";
import { applyOllamaConfig, applyOllamaProviderConfig } from "./onboard-auth.js";

describe("Ollama configuration", () => {
  describe("applyOllamaProviderConfig", () => {
    it("adds ollama provider with correct settings", () => {
      const cfg = applyOllamaProviderConfig({});
      expect(cfg.models?.providers?.ollama).toMatchObject({
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        apiKey: "local",
      });
    });

    it("includes models when provided", () => {
      const models = [{ id: "llama3", name: "Llama 3" }];
      const cfg = applyOllamaProviderConfig({}, models);
      expect(cfg.models?.providers?.ollama?.models).toEqual(models);
    });

    it("does not include models property when empty models array is provided", () => {
      const cfg = applyOllamaProviderConfig({}, []);
      expect(cfg.models?.providers?.ollama?.models).toBeUndefined();
    });
  });

  describe("applyOllamaConfig", () => {
    it("sets correct primary model", () => {
      const cfg = applyOllamaConfig({}, "ollama/llama3");
      expect(cfg.agents?.defaults?.model?.primary).toBe("ollama/llama3");
    });

    it("preserves existing model fallbacks", () => {
      const cfg = applyOllamaConfig({
        agents: {
          defaults: {
            model: { fallbacks: ["anthropic/claude-opus-4-5"] },
          },
        },
      }, "ollama/llama3");
      expect(cfg.agents?.defaults?.model?.fallbacks).toEqual(["anthropic/claude-opus-4-5"]);
    });
  });
});
