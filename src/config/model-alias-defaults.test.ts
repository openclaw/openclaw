import { expect, it, vi } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { applyModelDefaults as applyModelDefaultsWithPolicy } from "./defaults.js";
import type { ModelDefinitionConfig, ModelProviderConfig, OpenClawConfig } from "./types.js";

// mock-isolation: model default tests must not load provider plugins or apply provider-owned policy.
vi.mock("./provider-policy.js", () => ({
  applyProviderConfigDefaultsForConfig: (params: { config: OpenClawConfig }) => params.config,
  normalizeProviderConfigForConfigDefaults: (params: { providerConfig: ModelProviderConfig }) =>
    params.providerConfig,
}));

const emptyManifestRegistry = { plugins: [] } satisfies Pick<PluginManifestRegistry, "plugins">;

function applyModelDefaults(
  cfg: OpenClawConfig,
  options?: Parameters<typeof applyModelDefaultsWithPolicy>[1],
) {
  return applyModelDefaultsWithPolicy(cfg, options ?? { manifestRegistry: emptyManifestRegistry });
}

function providerConfig(
  provider: string,
  model: Partial<ModelDefinitionConfig> = {},
  defaults: { maxTokens?: number } = {},
): OpenClawConfig {
  const config = {
    baseUrl: "https://proxy.example/v1",
    api: "openai-completions",
    ...defaults,
    models: [{ id: "gpt-5.4", name: "GPT-5.4", ...model }],
  };
  // Authored rows omit metadata that applyModelDefaults materializes.
  return { models: { providers: { [provider]: config } } } as never;
}

function defaultModels(
  models: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"],
) {
  return applyModelDefaults({ agents: { defaults: { models } } }).agents?.defaults?.models;
}

function modelRefs(primary: string, fallbacks = [primary]) {
  return { model: { primary, fallbacks }, models: { [primary]: {} } };
}

const normalization = { aliases: { latest: "modern-model" }, prefixWhenBare: "vendor" };
const customManifestRegistry = {
  plugins: [
    createPluginManifestRecordFixture({
      id: "custom-provider-plugin",
      providers: ["myproxy"],
      modelIdNormalization: { providers: { myproxy: normalization } },
    }),
  ],
  diagnostics: [],
} satisfies PluginManifestRegistry;

it("preserves an authored Sonnet alias when the new default target is also present", () => {
  const models = {
    "anthropic/claude-sonnet-5": { alias: "Sonnet" },
    "anthropic/claude-sonnet-5-5": {},
  };
  expect(defaultModels(structuredClone(models))).toEqual(models);
});

it.each([undefined, ""])("defaults only unauthored Google aliases (%s)", (alias) => {
  expect(
    defaultModels({
      "google/gemini-4-argon": { alias },
      "google/gemini-3.8-flash": { alias },
      "google/gemini-3.5-flash-lite": { alias },
    }),
  ).toEqual({
    "google/gemini-4-argon": { alias: alias ?? "gemini" },
    "google/gemini-3.8-flash": { alias: alias ?? "gemini-flash" },
    "google/gemini-3.5-flash-lite": { alias: alias ?? "gemini-flash-lite" },
  });
});

it.each([
  ["defaults", "together/moonshotai/Kimi-K2.5", "together/moonshotai/Kimi-K2.6"],
  ["agent", "google/gemini-3-pro-preview", "google/gemini-3.1-pro-preview"],
])("normalizes retired %s model refs", (scope, old, current) => {
  const extra = scope === "defaults" ? ["openai/gpt-5.5"] : [];
  const refs = modelRefs(old, [old, ...extra]);
  const next = applyModelDefaults({
    agents: scope === "defaults" ? { defaults: refs } : { entries: { ops: refs } },
  });
  const actual = scope === "defaults" ? next.agents?.defaults : next.agents?.entries?.ops;
  expect([actual?.model, actual?.models]).toEqual([
    { primary: current, fallbacks: [current, ...extra] },
    { [current]: {} },
  ]);
});

it("normalizes configured provider rows with explicit manifest registry policies", () => {
  const next = applyModelDefaults(providerConfig("myproxy", { id: "latest" }), {
    manifestRegistry: customManifestRegistry,
  });

  expect(next.models?.providers?.myproxy?.models?.[0]?.id).toBe("vendor/modern-model");
});

it.each([undefined, 4096])("defaults output tokens without inventing context (%s)", (maxTokens) => {
  const model = applyModelDefaults(providerConfig("myproxy", {}, { maxTokens })).models?.providers
    ?.myproxy?.models?.[0];
  expect(model).toMatchObject({
    reasoning: false,
    input: ["text"],
    maxTokens: maxTokens ?? 8192,
  });
  expect([model?.contextWindow, model?.contextTokens]).toEqual([undefined, undefined]);
  expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

it.each([
  { id: "mistral-large-latest", contextWindow: 262_144, maxTokens: 262_144, expected: 16384 },
  { id: "constructor", contextWindow: 128_000, maxTokens: 32_000, expected: 32_000 },
  { id: "custom-mistral-model", contextWindow: 128_000, maxTokens: 128_000, expected: 8192 },
])("normalizes Mistral output limits for $id", ({ expected, ...model }) => {
  const actual = applyModelDefaults(providerConfig("mistral", model)).models?.providers?.mistral
    ?.models?.[0];
  expect(actual).toMatchObject({
    contextWindow: model.contextWindow,
    maxTokens: expected,
  });
});
