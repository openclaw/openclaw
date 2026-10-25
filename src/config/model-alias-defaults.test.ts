import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { applyModelDefaults as applyModelDefaultsWithPolicy } from "./defaults.js";
import type { ModelDefinitionConfig, ModelProviderConfig, OpenClawConfig } from "./types.js";

const providerPolicyMocks = vi.hoisted(() => ({
  normalizeProviderConfigForConfigDefaults: vi.fn(
    (params: { providerConfig: ModelProviderConfig }) => params.providerConfig,
  ),
}));

vi.mock("./provider-policy.js", () => ({
  applyProviderConfigDefaultsForConfig: (params: { config: OpenClawConfig }) => params.config,
  normalizeProviderConfigForConfigDefaults: (
    ...args: Parameters<typeof providerPolicyMocks.normalizeProviderConfigForConfigDefaults>
  ) => providerPolicyMocks.normalizeProviderConfigForConfigDefaults(...args),
}));

const emptyManifestRegistry = { plugins: [] } satisfies Pick<PluginManifestRegistry, "plugins">;

function applyModelDefaults(
  cfg: OpenClawConfig,
  options?: Parameters<typeof applyModelDefaultsWithPolicy>[1],
) {
  return applyModelDefaultsWithPolicy(cfg, options ?? { manifestRegistry: emptyManifestRegistry });
}

describe("applyModelDefaults", () => {
  beforeEach(() => {
    providerPolicyMocks.normalizeProviderConfigForConfigDefaults.mockReset();
    providerPolicyMocks.normalizeProviderConfigForConfigDefaults.mockImplementation(
      (params) => params.providerConfig,
    );
  });

  function providerConfig(
    provider: string,
    model: Partial<ModelDefinitionConfig> = {},
    defaults: { maxTokens?: number } = {},
  ) {
    const config = {
      baseUrl: "https://proxy.example/v1",
      apiKey: "sk-test",
      api: "openai-completions",
      ...defaults,
      models: [
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          ...model,
        },
      ],
    };
    return { models: { providers: { [provider]: config } } } as never;
  }

  function mistralModel(model: Partial<ModelDefinitionConfig> = {}) {
    return applyModelDefaults(
      providerConfig("mistral", {
        id: "mistral-large-latest",
        name: "Mistral",
        input: ["text", "image"],
        contextWindow: 262_144,
        maxTokens: 262_144,
        ...model,
      }),
    ).models?.providers?.mistral?.models?.[0];
  }

  function defaultModels(
    models: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"],
  ) {
    return applyModelDefaults({ agents: { defaults: { models } } }).agents?.defaults?.models;
  }

  function modelRefs(primary: string, fallbacks = [primary]) {
    return { model: { primary, fallbacks }, models: { [primary]: {} } };
  }

  function buildCustomProviderManifestRegistry() {
    return {
      plugins: [
        createPluginManifestRecordFixture({
          id: "custom-provider-plugin",
          providers: ["myproxy"],
          origin: "config",
          rootDir: "/tmp/custom-provider-plugin",
          source: "test",
          manifestPath: "/tmp/custom-provider-plugin/openclaw.plugin.json",
          modelIdNormalization: {
            providers: {
              myproxy: {
                aliases: { latest: "modern-model" },
                prefixWhenBare: "vendor",
              },
            },
          },
        }),
      ],
      diagnostics: [],
    } satisfies PluginManifestRegistry;
  }

  it("preserves an authored Sonnet alias when the new default target is also present", () => {
    const models = {
      "anthropic/claude-sonnet-5": { alias: "Sonnet" },
      "anthropic/claude-sonnet-5-5": {},
    };
    expect(defaultModels(structuredClone(models))).toEqual(models);
  });

  it.each([
    { name: "adds current Google aliases", alias: undefined },
    { name: "respects explicit empty alias disables", alias: "" },
  ])("$name", ({ alias }) => {
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
    const next = applyModelDefaults(
      providerConfig("myproxy", {
        id: "latest",
        name: "Custom latest",
        contextWindow: 200_000,
        maxTokens: 8192,
      }),
      {
        manifestRegistry: buildCustomProviderManifestRegistry(),
      },
    );

    expect(next.models?.providers?.myproxy?.models?.[0]?.id).toBe("vendor/modern-model");
  });

  it("leaves an omitted native context window undefined", () => {
    const model = applyModelDefaults(providerConfig("myproxy")).models?.providers?.myproxy
      ?.models?.[0];
    expect(model).toMatchObject({
      reasoning: false,
      input: ["text"],
      maxTokens: 8192,
    });
    expect(model?.contextWindow).toBeUndefined();
    expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("inherits only the provider output-token default", () => {
    const next = applyModelDefaults(providerConfig("myproxy", {}, { maxTokens: 4_096 }));
    const model = next.models?.providers?.myproxy?.models?.[0];
    expect([model?.contextWindow, model?.contextTokens, model?.maxTokens]).toEqual([
      undefined,
      undefined,
      4_096,
    ]);
  });

  it.each([
    { id: "mistral-large-latest", contextWindow: 262_144, maxTokens: 262_144, expected: 16384 },
    { id: "constructor", contextWindow: 128_000, maxTokens: 32_000, expected: 32_000 },
    { id: "custom-mistral-model", contextWindow: 128_000, maxTokens: 128_000, expected: 8192 },
  ])("normalizes Mistral output limits for $id", ({ expected, ...model }) => {
    expect(mistralModel(model)).toMatchObject({
      contextWindow: model.contextWindow,
      maxTokens: expected,
    });
  });
});
