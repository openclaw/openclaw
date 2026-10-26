import { expect, it, vi } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

function createModelRegistry(
  plugin: Parameters<typeof createPluginManifestRecordFixture>[0],
): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [createPluginManifestRecordFixture({ source: "test", ...plugin })],
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

it("rejects statically suppressed provider/model pairs during config validation", () => {
  const manifestRegistry = createModelSuppressionRegistry();
  const res = validateConfigObjectWithPlugins(
    { agents: { defaults: { model: { primary: "openai/gpt-5.3-codex-spark" } } } },
    { pluginMetadataSnapshot: { manifestRegistry } },
  );

  expect(res.ok ? undefined : res.issues).toEqual([
    {
      path: "agents.defaults.model.primary",
      message:
        "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is no longer exposed by the OpenAI or Codex catalogs. Use openai/gpt-5.5.",
    },
  ]);
});

it("loads model normalization policies when plugin validation is skipped", () => {
  const myproxy = {
    baseUrl: "https://proxy.example/v1",
    apiKey: "sk-test",
    api: "openai-completions",
    models: [{ id: "latest", name: "Custom latest" }],
  };
  const res = validateConfigObjectWithPlugins(
    { models: { providers: { myproxy } } },
    {
      pluginValidation: "skip",
      loadPluginMetadataSnapshot: () => ({
        manifestRegistry: createModelNormalizationRegistry(),
      }),
    },
  );

  expect(res.ok && res.config.models?.providers?.myproxy?.models?.[0]?.id).toBe(
    "vendor/modern-model",
  );
});

it("keeps core-only validation independent from plugin metadata", () => {
  const loadPluginMetadataSnapshot = vi.fn(() => ({
    manifestRegistry: createModelNormalizationRegistry(),
  }));
  const options = { pluginValidation: "core-only" as const, loadPluginMetadataSnapshot };
  const provider = {
    baseUrl: "http://127.0.0.1:19432/v1",
    api: "openai-completions",
    models: [],
  };
  const valid = validateConfigObjectWithPlugins(
    {
      gateway: { mode: "local" },
      models: { providers: { "fixture-external": provider } },
    },
    options,
  );
  const invalid = validateConfigObjectWithPlugins({ gateway: { port: "invalid" } }, options);

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
  const res = validateConfigObjectWithPlugins(
    { agents: { defaults: { modelPolicy: { allow: ["openai/gpt 5.5"] } } } },
    { pluginValidation: "skip" },
  );

  expect(res.ok ? undefined : res.issues[0]).toMatchObject({
    path: "agents.defaults.modelPolicy.allow.0",
    message: expect.stringContaining("invalid model policy ref"),
  });
});
