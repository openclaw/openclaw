import { describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

function createModelRegistry(
  plugin: Omit<
    PluginManifestRecord,
    "channels" | "cliBackends" | "skills" | "hooks" | "source" | "manifestPath"
  >,
): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      {
        channels: [],
        cliBackends: [],
        skills: [],
        hooks: [],
        source: "test",
        manifestPath: `${plugin.rootDir}/openclaw.plugin.json`,
        ...plugin,
      },
    ],
  };
}

function createModelSuppressionRegistry() {
  return createModelRegistry({
    id: "openai",
    origin: "bundled",
    providers: ["openai", "openai"],
    contracts: {},
    rootDir: "/tmp/plugins/openai",
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
  });
}

function createModelNormalizationRegistry() {
  return createModelRegistry({
    id: "custom-provider-plugin",
    providers: ["myproxy"],
    origin: "config",
    rootDir: "/tmp/custom-provider-plugin",
    modelIdNormalization: {
      providers: {
        myproxy: { aliases: { latest: "modern-model" }, prefixWhenBare: "vendor" },
      },
    },
  });
}

describe("config model reference validation", () => {
  it("rejects statically suppressed provider/model pairs during config validation", () => {
    const res = validateConfigObjectWithPlugins(
      { agents: { defaults: { model: { primary: "openai/gpt-5.3-codex-spark" } } } },
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

  it("loads model normalization policies when plugin validation is skipped", () => {
    const res = validateConfigObjectWithPlugins(
      {
        models: {
          providers: {
            myproxy: {
              baseUrl: "https://proxy.example/v1",
              apiKey: "sk-test",
              api: "openai-completions",
              models: [
                {
                  id: "latest",
                  name: "Custom latest",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 200_000,
                  maxTokens: 8192,
                },
              ],
            },
          },
        },
      },
      {
        pluginValidation: "skip",
        loadPluginMetadataSnapshot: () => ({
          manifestRegistry: createModelNormalizationRegistry(),
        }),
      },
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.models?.providers?.myproxy?.models?.[0]?.id).toBe("vendor/modern-model");
    }
  });

  it("keeps core-only validation independent from plugin metadata", () => {
    const loadPluginMetadataSnapshot = vi.fn(() => ({
      manifestRegistry: createModelNormalizationRegistry(),
    }));
    const valid = validateConfigObjectWithPlugins(
      {
        gateway: { mode: "local" },
        models: {
          providers: {
            "fixture-external": {
              baseUrl: "http://127.0.0.1:19432/v1",
              api: "openai-completions",
              models: [],
            },
          },
        },
      },
      { pluginValidation: "core-only", loadPluginMetadataSnapshot },
    );
    const invalid = validateConfigObjectWithPlugins(
      { gateway: { port: "invalid" } },
      { pluginValidation: "core-only", loadPluginMetadataSnapshot },
    );

    expect(valid.ok).toBe(true);
    expect(invalid.ok).toBe(false);
    expect(loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("accepts separator padding in per-agent policy", () => {
    const modelPolicy = { allow: [" openai / gpt-5.5 ", " openai / * ", " openai / ns / * "] };
    const agents = { entries: { worker: { modelPolicy } } };
    const res = validateConfigObjectWithPlugins({ agents }, { pluginValidation: "skip" });

    expect(res.ok).toBe(true);
  });

  it("rejects whitespace inside a model policy model name", () => {
    const ref = "openai/gpt 5.5";
    const res = validateConfigObjectWithPlugins(
      { agents: { defaults: { modelPolicy: { allow: [ref] } } } },
      { pluginValidation: "skip" },
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("agents.defaults.modelPolicy.allow.0");
      expect(res.issues[0]?.message).toContain("invalid model policy ref");
    }
  });
});
