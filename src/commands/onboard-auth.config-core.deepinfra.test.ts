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
} from "../providers/deepinfra-shared.js";
import { captureEnv } from "../test-utils/env.js";

const emptyCfg: OpenClawConfig = {};

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
    it("does not persist a provider block (discovery populates models at runtime)", () => {
      const result = applyDeepInfraProviderConfig(emptyCfg);
      expect(result.models?.providers?.deepinfra).toBeUndefined();
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

    it("does not persist a provider block (discovery populates models at runtime)", () => {
      const result = applyDeepInfraConfig(emptyCfg);
      expect(result.models?.providers?.deepinfra).toBeUndefined();
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
