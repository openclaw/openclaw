import { expect, it, vi } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import type { OpenClawConfig } from "./types.js";
import { validateConfigObjectWithPlugins as validate } from "./validation.js";

const registry = (
  plugin: Parameters<typeof createPluginManifestRecordFixture>[0],
): PluginManifestRegistry => ({
  diagnostics: [],
  plugins: [createPluginManifestRecordFixture(plugin)],
});
const metadata = () => ({
  manifestRegistry: registry({
    id: "proxy",
    providers: ["myproxy"],
    origin: "config",
    modelIdNormalization: {
      providers: { myproxy: { aliases: { latest: "modern-model" }, prefixWhenBare: "vendor" } },
    },
  }),
});
const provider = { baseUrl: "https://proxy.example/v1", api: "openai-completions", models: [] };

it("rejects statically suppressed provider/model pairs during config validation", () => {
  const reason = "This model is no longer exposed. Use openai/gpt-5.5.";
  const manifestRegistry = registry({
    id: "openai",
    providers: ["openai", "openai"],
    modelCatalog: { suppressions: [{ provider: "openai", model: "gpt-5.3-codex-spark", reason }] },
  });
  const result = validate(
    { agents: { defaults: { model: { primary: "openai/gpt-5.3-codex-spark" } } } },
    { pluginMetadataSnapshot: { manifestRegistry } },
  );
  expect(result.ok ? undefined : result.issues).toEqual([
    {
      path: "agents.defaults.model.primary",
      message: `Unknown model: openai/gpt-5.3-codex-spark. ${reason}`,
    },
  ]);
});

it("loads model normalization policies when plugin validation is skipped", () => {
  const myproxy = {
    ...provider,
    apiKey: "sk-test",
    models: [{ id: "latest", name: "Custom latest" }],
  };
  const result = validate(
    { models: { providers: { myproxy } } },
    {
      pluginValidation: "skip",
      loadPluginMetadataSnapshot: metadata,
    },
  );
  expect(result.ok && result.config.models?.providers?.myproxy?.models?.[0]?.id).toBe(
    "vendor/modern-model",
  );
});

it("keeps core-only validation independent from plugin metadata", () => {
  const loadPluginMetadataSnapshot = vi.fn(metadata);
  const options = { pluginValidation: "core-only" as const, loadPluginMetadataSnapshot };
  expect(
    validate(
      { gateway: { mode: "local" }, models: { providers: { "fixture-external": provider } } },
      options,
    ).ok,
  ).toBe(true);
  expect(validate({ gateway: { port: "invalid" } }, options).ok).toBe(false);
  expect(loadPluginMetadataSnapshot).not.toHaveBeenCalled();
});

const aliases = {
  "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
  "openrouter/openai/gpt-oss-120b:free": {},
};
type Models = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"];
it.each<[string, string[], Models?, string?]>([
  ["worker", [" openai / gpt-5.5 ", " openai / * ", " openai / ns / * "]],
  [
    "defaults",
    "openai/gpt-5.6-sol provider/a/b/c/d/e/f clawrouter/anthropic/* provider/a/b/c/d/* sonnet openrouter:free".split(
      " ",
    ),
    aliases,
  ],
  ["defaults", ["openai/gpt 5.5"], undefined, "agents.defaults.modelPolicy.allow.0"],
  ["runner", ["not-a-model-ref"], undefined, "agents.entries.runner.modelPolicy.allow.0"],
])("validates %s model policy %j", (scope, allow, models, path) => {
  const policy = { modelPolicy: { allow }, ...(models ? { models } : {}) };
  const agents =
    scope === "defaults"
      ? { defaults: policy, entries: { main: {} } }
      : { ownership: "explicit" as const, entries: { main: {}, [scope]: policy } };
  const result = validate({ agents }, { pluginValidation: "skip" });
  if (path) {
    expect(result.ok ? undefined : result.issues).toContainEqual(
      expect.objectContaining({
        path,
        message: expect.stringContaining("invalid model policy ref"),
      }),
    );
  } else {
    expect(result.ok).toBe(true);
  }
});
