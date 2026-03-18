import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyDeepInfraProviderConfig,
  applyDeepInfraConfig,
} from "../../extensions/deepinfra/onboard.js";
import { resolveApiKeyForProvider, resolveEnvApiKey } from "../agents/model-auth.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import {
  DEEPINFRA_BASE_URL,
  DEEPINFRA_DEFAULT_CONTEXT_WINDOW,
  DEEPINFRA_DEFAULT_COST,
  DEEPINFRA_DEFAULT_MODEL_ID,
  DEEPINFRA_DEFAULT_MODEL_REF,
  DEEPINFRA_DEFAULT_MAX_TOKENS,
  DEEPINFRA_MODEL_CATALOG,
} from "../providers/deepinfra-shared.js";
import { captureEnv } from "../test-utils/env.js";

const emptyCfg: OpenClawConfig = {};
const DEEPINFRA_MODEL_IDS = DEEPINFRA_MODEL_CATALOG.map((m) => m.id);

describe("DeepInfra provider config", () => {
  describe("constants", () => {
    it("DEEPINFRA_BASE_URL points to DeepInfra OpenAI-compatible endpoint", () => {
      expect(DEEPINFRA_BASE_URL).toBe("https://api.deepinfra.com/v1/openai/");
    });

    it("DEEPINFRA_DEFAULT_MODEL_REF includes provider prefix", () => {
      expect(DEEPINFRA_DEFAULT_MODEL_REF).toBe(`deepinfra/${DEEPINFRA_DEFAULT_MODEL_ID}`);
    });

    it("DEEPINFRA_DEFAULT_MODEL_ID is openai/gpt-oss-120b", () => {
      expect(DEEPINFRA_DEFAULT_MODEL_ID).toBe("openai/gpt-oss-120b");
    });

    it("DEEPINFRA_DEFAULT_CONTEXT_WINDOW is 128000", () => {
      expect(DEEPINFRA_DEFAULT_CONTEXT_WINDOW).toBe(128000);
    });

    it("DEEPINFRA_DEFAULT_MAX_TOKENS is 8192", () => {
      expect(DEEPINFRA_DEFAULT_MAX_TOKENS).toBe(8192);
    });

    it("DEEPINFRA_DEFAULT_COST has zero values", () => {
      expect(DEEPINFRA_DEFAULT_COST).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
    });
  });

  describe("applyDeepInfraProviderConfig", () => {
    it("registers deepinfra provider with correct baseUrl and api", () => {
      const result = applyDeepInfraProviderConfig(emptyCfg);
      const provider = result.models?.providers?.deepinfra;
      expect(provider).toBeDefined();
      expect(provider?.baseUrl).toBe(DEEPINFRA_BASE_URL);
      expect(provider?.api).toBe("openai-completions");
    });

    it("includes the default model in the provider model list", () => {
      const result = applyDeepInfraProviderConfig(emptyCfg);
      const provider = result.models?.providers?.deepinfra;
      const models = provider?.models;
      expect(Array.isArray(models)).toBe(true);
      const modelIds = models?.map((m) => m.id) ?? [];
      expect(modelIds).toContain(DEEPINFRA_DEFAULT_MODEL_ID);
    });

    it("surfaces the full DeepInfra model catalog", () => {
      const result = applyDeepInfraProviderConfig(emptyCfg);
      const provider = result.models?.providers?.deepinfra;
      const modelIds = provider?.models?.map((m) => m.id) ?? [];
      for (const modelId of DEEPINFRA_MODEL_IDS) {
        expect(modelIds).toContain(modelId);
      }
    });

    it("appends missing catalog models to existing DeepInfra provider config", () => {
      const result = applyDeepInfraProviderConfig({
        models: {
          providers: {
            deepinfra: {
              baseUrl: DEEPINFRA_BASE_URL,
              api: "openai-completions",
              models: [{ ...DEEPINFRA_MODEL_CATALOG[0], cost: DEEPINFRA_DEFAULT_COST }],
            },
          },
        },
      });
      const modelIds = result.models?.providers?.deepinfra?.models?.map((m) => m.id) ?? [];
      for (const modelId of DEEPINFRA_MODEL_IDS) {
        expect(modelIds).toContain(modelId);
      }
    });

    it("sets DeepInfra alias in agent default models", () => {
      const result = applyDeepInfraProviderConfig(emptyCfg);
      const agentModel = result.agents?.defaults?.models?.[DEEPINFRA_DEFAULT_MODEL_REF];
      expect(agentModel).toBeDefined();
      expect(agentModel?.alias).toBe("DeepInfra");
    });

    it("preserves existing alias if already set", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              [DEEPINFRA_DEFAULT_MODEL_REF]: { alias: "My Custom Alias" },
            },
          },
        },
      };
      const result = applyDeepInfraProviderConfig(cfg);
      const agentModel = result.agents?.defaults?.models?.[DEEPINFRA_DEFAULT_MODEL_REF];
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
      const result = applyDeepInfraProviderConfig(cfg);
      expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe("openai/gpt-5");
    });
  });

  describe("applyDeepInfraConfig", () => {
    it("sets deepinfra's default model as the config's default model", () => {
      const result = applyDeepInfraConfig(emptyCfg);
      expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe(
        DEEPINFRA_DEFAULT_MODEL_REF,
      );
    });

    it("also registers the provider", () => {
      const result = applyDeepInfraConfig(emptyCfg);
      const provider = result.models?.providers?.deepinfra;
      expect(provider).toBeDefined();
      expect(provider?.baseUrl).toBe(DEEPINFRA_BASE_URL);
    });
  });

  describe("env var resolution", () => {
    it("resolves DEEPINFRA_API_KEY from env", () => {
      const envSnapshot = captureEnv(["DEEPINFRA_API_KEY"]);
      process.env.DEEPINFRA_API_KEY = "test-deepinfra-key"; // pragma: allowlist secret

      try {
        const result = resolveEnvApiKey("deepinfra");
        expect(result).not.toBeNull();
        expect(result?.apiKey).toBe("test-deepinfra-key");
        expect(result?.source).toContain("DEEPINFRA_API_KEY");
      } finally {
        envSnapshot.restore();
      }
    });

    it("returns null when DEEPINFRA_API_KEY is not set", () => {
      const envSnapshot = captureEnv(["DEEPINFRA_API_KEY"]);
      delete process.env.DEEPINFRA_API_KEY;

      try {
        const result = resolveEnvApiKey("deepinfra");
        expect(result).toBeNull();
      } finally {
        envSnapshot.restore();
      }
    });

    it("resolves the deepinfra api key via resolveApiKeyForProvider", async () => {
      const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
      const envSnapshot = captureEnv(["DEEPINFRA_API_KEY"]);
      process.env.DEEPINFRA_API_KEY = "deepinfra-provider-test-key"; // pragma: allowlist secret

      try {
        const auth = await resolveApiKeyForProvider({
          provider: "deepinfra",
          agentDir,
        });

        expect(auth.apiKey).toBe("deepinfra-provider-test-key");
        expect(auth.mode).toBe("api-key");
        expect(auth.source).toContain("DEEPINFRA_API_KEY");
      } finally {
        envSnapshot.restore();
      }
    });
  });
});
