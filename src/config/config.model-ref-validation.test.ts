// Verifies model reference validation in config surfaces.
import { describe, expect, it } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

function createModelSuppressionRegistry(): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      {
        id: "openai",
        origin: "bundled",
        channels: [],
        providers: ["openai", "openai"],
        contracts: {},
        cliBackends: [],
        skills: [],
        hooks: [],
        rootDir: "/tmp/plugins/openai",
        source: "test",
        manifestPath: "/tmp/plugins/openai/openclaw.plugin.json",
        modelCatalog: {
          suppressions: [
            {
              provider: "openai",
              model: "gpt-5.3-codex-spark",
              reason:
                "gpt-5.3-codex-spark is no longer exposed by the OpenAI or Codex catalogs. Use openai/gpt-5.5.",
            },
          ],
        },
      },
    ],
  };
}

function createConditionalModelSuppressionRegistry(): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      {
        id: "openai",
        origin: "bundled",
        channels: [],
        providers: ["openai"],
        contracts: {},
        cliBackends: [],
        skills: [],
        hooks: [],
        rootDir: "/tmp/plugins/openai",
        source: "test",
        manifestPath: "/tmp/plugins/openai/openclaw.plugin.json",
        modelCatalog: {
          suppressions: [
            {
              provider: "openai",
              model: "gpt-5.3-codex-spark",
              reason:
                "gpt-5.3-codex-spark is not exposed by the OpenAI API catalog. Use the Codex harness route when your signed-in account exposes it.",
              when: {
                providerConfigApiIn: ["openai-responses", "openai-completions"],
                baseUrlHosts: ["api.openai.com"],
              },
            },
            {
              provider: "openai",
              model: "gpt-5.3-codex-spark",
              reason:
                "gpt-5.3-codex-spark is not exposed by the OpenAI API catalog. Use the Codex harness route when your signed-in account exposes it.",
              when: {
                baseUrlHosts: ["api.openai.com"],
              },
            },
          ],
        },
      },
    ],
  };
}

function createInlineSparkModel(baseUrl: string, id = "gpt-5.3-codex-spark") {
  return {
    id,
    name: "GPT-5.3 Codex Spark",
    api: "openai-responses",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 64_000,
  };
}

describe("config model reference validation", () => {
  it("rejects statically suppressed provider/model pairs during config validation", () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.3-codex-spark",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createModelSuppressionRegistry(),
        },
      },
    );

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.issues).toEqual([
      {
        path: "agents.defaults.model.primary",
        message:
          "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is no longer exposed by the OpenAI or Codex catalogs. Use openai/gpt-5.5.",
      },
    ]);
  });

  it("accepts supported openai provider/model pairs", () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4-mini",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createModelSuppressionRegistry(),
        },
      },
    );

    expect(res.ok).toBe(true);
  });

  it("accepts conditionally suppressed openai/codex spark model refs without direct API config", () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.3-codex-spark",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createConditionalModelSuppressionRegistry(),
        },
      },
    );

    expect(res.ok).toBe(true);
  });

  it("rejects conditionally suppressed openai/codex spark model refs for auth-profile API-key config", () => {
    const res = validateConfigObjectWithPlugins(
      {
        auth: {
          profiles: {
            "openai:api": {
              provider: "openai",
              mode: "api_key",
            },
          },
          order: {
            openai: ["openai:api"],
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.3-codex-spark",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createConditionalModelSuppressionRegistry(),
        },
      },
    );

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.issues).toEqual([
      {
        path: "agents.defaults.model.primary",
        message:
          "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is not exposed by the OpenAI API catalog. Use the Codex harness route when your signed-in account exposes it.",
      },
    ]);
  });

  it("normalizes auth order keys when validating auth-profile API-key spark configs", () => {
    const res = validateConfigObjectWithPlugins(
      {
        auth: {
          profiles: {
            "openai:api": {
              provider: "openai",
              mode: "api_key",
            },
            "openai:codex": {
              provider: "openai",
              mode: "oauth",
            },
          },
          order: {
            OpenAI: ["openai:api"],
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.3-codex-spark",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createConditionalModelSuppressionRegistry(),
        },
      },
    );

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.issues).toEqual([
      {
        path: "agents.defaults.model.primary",
        message:
          "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is not exposed by the OpenAI API catalog. Use the Codex harness route when your signed-in account exposes it.",
      },
    ]);
  });

  it("rejects conditionally suppressed openai/codex spark model refs for direct API config", () => {
    const res = validateConfigObjectWithPlugins(
      {
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              models: [],
            },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.3-codex-spark",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createConditionalModelSuppressionRegistry(),
        },
      },
    );

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.issues).toEqual([
      {
        path: "agents.defaults.model.primary",
        message:
          "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is not exposed by the OpenAI API catalog. Use the Codex harness route when your signed-in account exposes it.",
      },
    ]);
  });

  it("rejects conditionally suppressed openai/codex spark inline native API rows", () => {
    const res = validateConfigObjectWithPlugins(
      {
        models: {
          providers: {
            openai: {
              models: [createInlineSparkModel("https://api.openai.com/v1")],
            },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.3-codex-spark",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createConditionalModelSuppressionRegistry(),
        },
      },
    );

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.issues).toEqual([
      {
        path: "agents.defaults.model.primary",
        message:
          "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is not exposed by the OpenAI API catalog. Use the Codex harness route when your signed-in account exposes it.",
      },
    ]);
  });

  it("rejects conditionally suppressed openai/codex spark provider-qualified inline native API rows", () => {
    const res = validateConfigObjectWithPlugins(
      {
        models: {
          providers: {
            openai: {
              models: [
                createInlineSparkModel("https://api.openai.com/v1", "openai/gpt-5.3-codex-spark"),
              ],
            },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.3-codex-spark",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createConditionalModelSuppressionRegistry(),
        },
      },
    );

    expect(res.ok).toBe(false);
  });

  it("rejects conditionally suppressed openai/codex spark model refs for direct API base URL config", () => {
    const res = validateConfigObjectWithPlugins(
      {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.3-codex-spark",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createConditionalModelSuppressionRegistry(),
        },
      },
    );

    expect(res.ok).toBe(false);
  });

  it("rejects conditionally suppressed openai/codex spark model refs for default API-key config", () => {
    const res = validateConfigObjectWithPlugins(
      {
        models: {
          providers: {
            openai: {
              auth: "api-key",
              models: [],
            },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.3-codex-spark",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createConditionalModelSuppressionRegistry(),
        },
      },
    );

    expect(res.ok).toBe(false);
  });

  it("accepts conditionally suppressed openai/codex spark model refs for custom proxy config", () => {
    for (const providerConfig of [
      {
        api: "openai-responses",
        baseUrl: "https://proxy.example.test/v1",
        models: [],
      },
      {
        auth: "api-key",
        baseUrl: "https://proxy.example.test/v1",
        models: [],
      },
    ]) {
      const res = validateConfigObjectWithPlugins(
        {
          models: {
            providers: {
              openai: providerConfig,
            },
          },
          agents: {
            defaults: {
              model: {
                primary: "openai/gpt-5.3-codex-spark",
              },
            },
          },
        },
        {
          pluginMetadataSnapshot: {
            manifestRegistry: createConditionalModelSuppressionRegistry(),
          },
        },
      );

      expect(res.ok).toBe(true);
    }
  });

  it("accepts conditionally suppressed openai/codex spark inline custom proxy rows", () => {
    const res = validateConfigObjectWithPlugins(
      {
        models: {
          providers: {
            openai: {
              models: [createInlineSparkModel("https://proxy.example.test/v1")],
            },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.3-codex-spark",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createConditionalModelSuppressionRegistry(),
        },
      },
    );

    expect(res.ok).toBe(true);
  });

  it("accepts conditionally suppressed openai/codex spark provider-qualified inline custom proxy rows", () => {
    const res = validateConfigObjectWithPlugins(
      {
        models: {
          providers: {
            openai: {
              models: [
                createInlineSparkModel(
                  "https://proxy.example.test/v1",
                  "openai/gpt-5.3-codex-spark",
                ),
              ],
            },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.3-codex-spark",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createConditionalModelSuppressionRegistry(),
        },
      },
    );

    expect(res.ok).toBe(true);
  });

  it("accepts conditionally suppressed openai/codex spark model refs for Codex harness config", () => {
    const res = validateConfigObjectWithPlugins(
      {
        models: {
          providers: {
            openai: {
              api: "openai-chatgpt-responses",
              models: [],
            },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.3-codex-spark",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createConditionalModelSuppressionRegistry(),
        },
      },
    );

    expect(res.ok).toBe(true);
  });

  it("accepts available openai fallback model pairs", () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4-mini",
              fallbacks: ["openai/gpt-5.2-codex", "openai/gpt-5.3-codex"],
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createModelSuppressionRegistry(),
        },
      },
    );

    expect(res.ok).toBe(true);
  });
});
