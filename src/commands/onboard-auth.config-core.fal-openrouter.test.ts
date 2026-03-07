import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FAL_OPENROUTER_BASE_URL,
  FAL_OPENROUTER_MODEL_CATALOG,
  buildFalOpenrouterModelDefinition,
} from "../agents/fal-openrouter-models.js";
import { resolveApiKeyForProvider, resolveEnvApiKey } from "../agents/model-auth.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { captureEnv } from "../test-utils/env.js";
import {
  applyFalOpenrouterConfig,
  applyFalOpenrouterProviderConfig,
} from "./onboard-auth.config-core.js";
import { FAL_OPENROUTER_DEFAULT_MODEL_REF } from "./onboard-auth.credentials.js";

const emptyCfg: OpenClawConfig = {};

describe("Fal OpenRouter provider config", () => {
  describe("constants", () => {
    it("FAL_OPENROUTER_BASE_URL points to fal openrouter endpoint", () => {
      expect(FAL_OPENROUTER_BASE_URL).toBe("https://fal.run/openrouter/router/openai/v1");
    });

    it("FAL_OPENROUTER_DEFAULT_MODEL_REF includes provider prefix", () => {
      expect(FAL_OPENROUTER_DEFAULT_MODEL_REF).toBe("fal-openrouter/google/gemini-2.5-flash");
    });

    it("model catalog contains expected models", () => {
      const ids = FAL_OPENROUTER_MODEL_CATALOG.map((m) => m.id);
      expect(ids).toContain("google/gemini-2.5-flash");
      expect(ids).toContain("anthropic/claude-sonnet-4.6");
      expect(ids).toContain("anthropic/claude-opus-4.6");
      expect(ids).toContain("openai/gpt-4.1");
    });
  });

  describe("buildFalOpenrouterModelDefinition", () => {
    it("returns correct model shape for first catalog entry", () => {
      const model = buildFalOpenrouterModelDefinition(FAL_OPENROUTER_MODEL_CATALOG[0]);
      expect(model.id).toBe("google/gemini-2.5-flash");
      expect(model.name).toBe("Gemini 2.5 Flash");
      expect(model.api).toBe("openai-completions");
      expect(model.reasoning).toBe(true);
      expect(model.input).toEqual(["text", "image"]);
      expect(model.contextWindow).toBe(1048576);
      expect(model.maxTokens).toBe(65536);
    });

    it("preserves cost metadata", () => {
      const model = buildFalOpenrouterModelDefinition(FAL_OPENROUTER_MODEL_CATALOG[0]);
      expect(model.cost).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.0375, cacheWrite: 0.15 });
    });
  });

  describe("applyFalOpenrouterProviderConfig", () => {
    it("registers fal-openrouter provider with correct baseUrl and api", () => {
      const result = applyFalOpenrouterProviderConfig(emptyCfg);
      const provider = result.models?.providers?.["fal-openrouter"];
      expect(provider).toBeDefined();
      expect(provider?.baseUrl).toBe(FAL_OPENROUTER_BASE_URL);
      expect(provider?.api).toBe("openai-completions");
    });

    it("includes the full model catalog in the provider", () => {
      const result = applyFalOpenrouterProviderConfig(emptyCfg);
      const provider = result.models?.providers?.["fal-openrouter"];
      const models = provider?.models;
      expect(Array.isArray(models)).toBe(true);
      expect(models?.length).toBe(FAL_OPENROUTER_MODEL_CATALOG.length);
    });

    it("sets Fal OpenRouter alias in agent default models", () => {
      const result = applyFalOpenrouterProviderConfig(emptyCfg);
      const agentModel = result.agents?.defaults?.models?.[FAL_OPENROUTER_DEFAULT_MODEL_REF];
      expect(agentModel).toBeDefined();
      expect(agentModel?.alias).toBe("Fal OpenRouter");
    });

    it("preserves existing alias if already set", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              [FAL_OPENROUTER_DEFAULT_MODEL_REF]: { alias: "My Custom Alias" },
            },
          },
        },
      };
      const result = applyFalOpenrouterProviderConfig(cfg);
      const agentModel = result.agents?.defaults?.models?.[FAL_OPENROUTER_DEFAULT_MODEL_REF];
      expect(agentModel?.alias).toBe("My Custom Alias");
    });

    it("does not change the default model selection", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5" },
          },
        },
      };
      const result = applyFalOpenrouterProviderConfig(cfg);
      expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe("openai/gpt-5");
    });
  });

  describe("applyFalOpenrouterConfig", () => {
    it("sets fal-openrouter as the default model", () => {
      const result = applyFalOpenrouterConfig(emptyCfg);
      expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe(
        FAL_OPENROUTER_DEFAULT_MODEL_REF,
      );
    });

    it("also registers the provider", () => {
      const result = applyFalOpenrouterConfig(emptyCfg);
      const provider = result.models?.providers?.["fal-openrouter"];
      expect(provider).toBeDefined();
      expect(provider?.baseUrl).toBe(FAL_OPENROUTER_BASE_URL);
    });
  });

  describe("env var resolution", () => {
    it("resolves FAL_API_KEY from env", () => {
      const envSnapshot = captureEnv(["FAL_API_KEY"]);
      process.env.FAL_API_KEY = "test-fal-key";

      try {
        const result = resolveEnvApiKey("fal-openrouter");
        expect(result).not.toBeNull();
        expect(result?.apiKey).toBe("test-fal-key");
        expect(result?.source).toContain("FAL_API_KEY");
      } finally {
        envSnapshot.restore();
      }
    });

    it("returns null when FAL_API_KEY is not set", () => {
      const envSnapshot = captureEnv(["FAL_API_KEY"]);
      delete process.env.FAL_API_KEY;

      try {
        const result = resolveEnvApiKey("fal-openrouter");
        expect(result).toBeNull();
      } finally {
        envSnapshot.restore();
      }
    });

    it("resolves the fal api key via resolveApiKeyForProvider", async () => {
      const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
      const envSnapshot = captureEnv(["FAL_API_KEY"]);
      process.env.FAL_API_KEY = "fal-provider-test-key";

      try {
        const auth = await resolveApiKeyForProvider({
          provider: "fal-openrouter",
          agentDir,
        });

        expect(auth.apiKey).toBe("fal-provider-test-key");
        expect(auth.mode).toBe("api-key");
        expect(auth.source).toContain("FAL_API_KEY");
      } finally {
        envSnapshot.restore();
      }
    });
  });
});
