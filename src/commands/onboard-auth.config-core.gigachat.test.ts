import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { applyGigachatConfig, applyGigachatProviderConfig } from "./onboard-auth.config-core.js";
import {
  buildGigachatModelDefinition,
  GIGACHAT_BASE_URL,
  GIGACHAT_BASIC_BASE_URL,
  GIGACHAT_DEFAULT_CONTEXT_WINDOW,
  GIGACHAT_DEFAULT_COST,
  GIGACHAT_DEFAULT_MAX_TOKENS,
  GIGACHAT_DEFAULT_MODEL_ID,
  GIGACHAT_DEFAULT_MODEL_REF,
} from "./onboard-auth.models.js";

const emptyCfg: OpenClawConfig = {};

describe("GigaChat provider config", () => {
  describe("buildGigachatModelDefinition", () => {
    it("keeps GigaChat 2 Max text-only until multimodal support lands", () => {
      const model = buildGigachatModelDefinition();

      expect(model.id).toBe(GIGACHAT_DEFAULT_MODEL_ID);
      expect(model.name).toBe("GigaChat 2 Max");
      expect(model.reasoning).toBe(false);
      expect(model.input).toEqual(["text"]);
      expect(model.contextWindow).toBe(GIGACHAT_DEFAULT_CONTEXT_WINDOW);
      expect(model.maxTokens).toBe(GIGACHAT_DEFAULT_MAX_TOKENS);
      expect(model.cost).toEqual(GIGACHAT_DEFAULT_COST);
    });
  });

  describe("applyGigachatProviderConfig", () => {
    it("registers the text-only default model", () => {
      const result = applyGigachatProviderConfig(emptyCfg);
      const provider = result.models?.providers?.gigachat;
      const model = provider?.models?.find((entry) => entry.id === GIGACHAT_DEFAULT_MODEL_ID);

      expect(provider?.baseUrl).toBe(GIGACHAT_BASE_URL);
      expect(provider?.api).toBe("openai-completions");
      expect(model?.input).toEqual(["text"]);
    });

    it("sets the default GigaChat alias without changing the selected primary model", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5" },
          },
        },
      };

      const result = applyGigachatProviderConfig(cfg);

      expect(result.agents?.defaults?.models?.[GIGACHAT_DEFAULT_MODEL_REF]?.alias).toBe("GigaChat");
      expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe("openai/gpt-5");
    });

    it("preserves an existing custom base URL when re-auth does not pass one", () => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            gigachat: {
              baseUrl: "https://preview.gigachat.example/api/v1",
              api: "openai-completions",
              models: [],
            },
          },
        },
      };

      const result = applyGigachatProviderConfig(cfg);

      expect(result.models?.providers?.gigachat?.baseUrl).toBe(
        "https://preview.gigachat.example/api/v1",
      );
    });

    it("resets the stock Basic auth host when reapplying OAuth config", () => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            gigachat: {
              baseUrl: GIGACHAT_BASIC_BASE_URL,
              api: "openai-completions",
              models: [],
            },
          },
        },
      };

      const result = applyGigachatProviderConfig(cfg);

      expect(result.models?.providers?.gigachat?.baseUrl).toBe(GIGACHAT_BASE_URL);
    });
  });

  describe("applyGigachatConfig", () => {
    it("sets GigaChat as the default model", () => {
      const result = applyGigachatConfig(emptyCfg);

      expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe(
        GIGACHAT_DEFAULT_MODEL_REF,
      );
    });
  });
});
