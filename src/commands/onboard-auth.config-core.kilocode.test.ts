import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveApiKeyForProvider, resolveEnvApiKey } from "../agents/model-auth.js";
import type { OpenClawConfig } from "../config/config.js";
import { captureEnv } from "../test-utils/env.js";
import {
  applyKilocodeProviderConfig,
  applyKilocodeConfig,
  KILOCODE_BASE_URL,
} from "./onboard-auth.config-core.js";
import { KILOCODE_DEFAULT_MODEL_REF } from "./onboard-auth.credentials.js";
import {
  buildKilocodeModelDefinition,
  KILOCODE_DEFAULT_MODEL_ID,
  KILOCODE_DEFAULT_CONTEXT_WINDOW,
  KILOCODE_DEFAULT_MAX_TOKENS,
  KILOCODE_DEFAULT_COST,
} from "./onboard-auth.models.js";

const emptyCfg: OpenClawConfig = {};

describe("Kilo Gateway provider config", () => {
  describe("constants", () => {
    it("KILOCODE_BASE_URL points to kilo openrouter endpoint", () => {
      expect(KILOCODE_BASE_URL).toBe("https://api.kilo.ai/api/gateway/");
    });

    it("KILOCODE_DEFAULT_MODEL_REF includes provider prefix", () => {
      expect(KILOCODE_DEFAULT_MODEL_REF).toBe("kilocode/anthropic/claude-opus-4.6");
    });

    it("KILOCODE_DEFAULT_MODEL_ID is anthropic/claude-opus-4.6", () => {
      expect(KILOCODE_DEFAULT_MODEL_ID).toBe("anthropic/claude-opus-4.6");
    });
  });

  describe("buildKilocodeModelDefinition", () => {
    it("returns correct model shape", () => {
      const model = buildKilocodeModelDefinition();
      expect(model.id).toBe(KILOCODE_DEFAULT_MODEL_ID);
      expect(model.name).toBe("Claude Opus 4.6");
      expect(model.reasoning).toBe(true);
      expect(model.input).toEqual(["text", "image"]);
      expect(model.contextWindow).toBe(KILOCODE_DEFAULT_CONTEXT_WINDOW);
      expect(model.maxTokens).toBe(KILOCODE_DEFAULT_MAX_TOKENS);
      expect(model.cost).toEqual(KILOCODE_DEFAULT_COST);
    });
  });

  describe("applyKilocodeProviderConfig", () => {
    it("registers kilocode provider with correct baseUrl and api", () => {
      const result = applyKilocodeProviderConfig(emptyCfg);
      const provider = result.models?.providers?.kilocode;
      expect(provider).toBeDefined();
      expect(provider?.baseUrl).toBe(KILOCODE_BASE_URL);
      expect(provider?.api).toBe("openai-completions");
    });

    it("includes the default model in the provider model list", () => {
      const result = applyKilocodeProviderConfig(emptyCfg);
      const provider = result.models?.providers?.kilocode;
      const models = provider?.models;
      expect(Array.isArray(models)).toBe(true);
      const modelIds = models?.map((m) => m.id) ?? [];
      expect(modelIds).toContain(KILOCODE_DEFAULT_MODEL_ID);
    });

    it("sets Kilo Gateway alias in agent default models", () => {
      const result = applyKilocodeProviderConfig(emptyCfg);
      const agentModel = result.agents?.defaults?.models?.[KILOCODE_DEFAULT_MODEL_REF];
      expect(agentModel).toBeDefined();
      expect(agentModel?.alias).toBe("Kilo Gateway");
    });

    it("preserves existing alias if already set", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              [KILOCODE_DEFAULT_MODEL_REF]: { alias: "My Custom Alias" },
            },
          },
        },
      };
      const result = applyKilocodeProviderConfig(cfg);
      const agentModel = result.agents?.defaults?.models?.[KILOCODE_DEFAULT_MODEL_REF];
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
      const result = applyKilocodeProviderConfig(cfg);
      expect(result.agents?.defaults?.model?.primary).toBe("openai/gpt-5");
    });
  });

  describe("applyKilocodeConfig", () => {
    it("sets kilocode as the default model", () => {
      const result = applyKilocodeConfig(emptyCfg);
      expect(result.agents?.defaults?.model?.primary).toBe(KILOCODE_DEFAULT_MODEL_REF);
    });

    it("also registers the provider", () => {
      const result = applyKilocodeConfig(emptyCfg);
      const provider = result.models?.providers?.kilocode;
      expect(provider).toBeDefined();
      expect(provider?.baseUrl).toBe(KILOCODE_BASE_URL);
    });
  });

  describe("env var resolution", () => {
    it("resolves KILOCODE_API_KEY from env", () => {
      const envSnapshot = captureEnv(["KILOCODE_API_KEY"]);
      process.env.KILOCODE_API_KEY = "test-kilo-key";

      try {
        const result = resolveEnvApiKey("kilocode");
        expect(result).not.toBeNull();
        expect(result?.apiKey).toBe("test-kilo-key");
        expect(result?.source).toContain("KILOCODE_API_KEY");
      } finally {
        envSnapshot.restore();
      }
    });

    it("returns null when KILOCODE_API_KEY is not set", () => {
      const envSnapshot = captureEnv(["KILOCODE_API_KEY"]);
      delete process.env.KILOCODE_API_KEY;

      try {
        const result = resolveEnvApiKey("kilocode");
        expect(result).toBeNull();
      } finally {
        envSnapshot.restore();
      }
    });

    it("resolves the kilocode api key via resolveApiKeyForProvider", async () => {
      const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
      const envSnapshot = captureEnv(["KILOCODE_API_KEY"]);
      process.env.KILOCODE_API_KEY = "kilo-provider-test-key";

      try {
        const auth = await resolveApiKeyForProvider({
          provider: "kilocode",
          agentDir,
        });

        expect(auth.apiKey).toBe("kilo-provider-test-key");
        expect(auth.mode).toBe("api-key");
        expect(auth.source).toContain("KILOCODE_API_KEY");
      } finally {
        envSnapshot.restore();
      }
    });
  });
});
