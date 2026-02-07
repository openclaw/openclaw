import { describe, expect, it } from "vitest";
import { DEEPSEEK_BASE_URL } from "../agents/models-config.providers.js";
import {
  applyDeepseekConfig,
  applyDeepseekProviderConfig,
  DEEPSEEK_DEFAULT_MODEL_REF,
} from "./onboard-auth.js";

describe("applyDeepseekConfig", () => {
  it("adds DeepSeek provider with correct settings", () => {
    const cfg = applyDeepseekConfig({});
    expect(cfg.models?.providers?.deepseek).toMatchObject({
      baseUrl: DEEPSEEK_BASE_URL,
      api: "openai-completions",
    });
    expect(cfg.agents?.defaults?.model?.primary).toBe(DEEPSEEK_DEFAULT_MODEL_REF);
  });

  it("preserves existing model fallbacks", () => {
    const cfg = applyDeepseekConfig({
      agents: {
        defaults: {
          model: { fallbacks: ["anthropic/claude-opus-4-5"] },
        },
      },
    });
    expect(cfg.agents?.defaults?.model?.fallbacks).toEqual(["anthropic/claude-opus-4-5"]);
  });
});

describe("applyDeepseekProviderConfig", () => {
  it("adds model alias", () => {
    const cfg = applyDeepseekProviderConfig({});
    expect(cfg.agents?.defaults?.models?.[DEEPSEEK_DEFAULT_MODEL_REF]?.alias).toBe("DeepSeek V3");
  });

  it("merges DeepSeek models and keeps existing provider overrides", () => {
    const cfg = applyDeepseekProviderConfig({
      models: {
        providers: {
          deepseek: {
            baseUrl: "https://old.example.com",
            apiKey: "old-key",
            api: "anthropic-messages",
            models: [
              {
                id: "custom-model",
                name: "Custom",
                reasoning: false,
                input: ["text"],
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1000,
                maxTokens: 100,
              },
            ],
          },
        },
      },
    });

    expect(cfg.models?.providers?.deepseek?.baseUrl).toBe(DEEPSEEK_BASE_URL);
    expect(cfg.models?.providers?.deepseek?.api).toBe("openai-completions");
    expect(cfg.models?.providers?.deepseek?.apiKey).toBe("old-key");
    const ids = cfg.models?.providers?.deepseek?.models.map((m) => m.id);
    expect(ids).toContain("custom-model");
    expect(ids).toContain("deepseek-chat");
  });
});
