import { describe, expect, it } from "vitest";
import type { OpenClawConfig, OpenClawConfigInput } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import { applyProviderAuthConfigPatch as applySdkAuthPatch } from "../plugin-sdk/provider-auth.js";
import { applyProviderAuthConfigPatchWithNormalization as applyAuthPatch } from "./provider-auth-choice-helpers.js";
import type { ProviderAuthResult } from "./provider-authentication.types.js";

const providerConfigNormalizer = ({ providerConfig }: { providerConfig: ModelProviderConfig }) =>
  providerConfig;
const normalization = { providerConfigNormalizer };
const providerPatch = <T>(providers: T) => ({ models: { providers } });
const pluginPatch = <T>(config: T) => ({ plugins: { entries: { example: { config } } } });
const retiredGemini = "google/gemini-3-pro-preview";
const currentGemini = "google/gemini-3.1-pro-preview";
const model = (
  overrides: Partial<ModelProviderConfig["models"][number]> = {},
): ModelProviderConfig["models"][number] => ({
  id: retiredGemini,
  name: "Gemini 3 Pro Preview",
  input: ["text", "image"],
  reasoning: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: 65_536,
  ...overrides,
});

describe("applyProviderAuthConfigPatchWithNormalization", () => {
  const base = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: ["openai/gpt-5.2"] },
        models: {
          "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
          "anthropic/claude-opus-4-6": { alias: "Opus" },
          "openai/gpt-5.2": {},
        },
      },
    },
  };

  it("merges default model maps by default so other providers survive login", () => {
    const patch = { agents: { defaults: { models: { "openai/gpt-5.5": {} } } } };
    const next = applyAuthPatch(base, patch);
    expect(next.agents?.defaults?.models).toEqual({
      ...base.agents.defaults.models,
      "openai/gpt-5.5": {},
    });
    expect(next.agents?.defaults?.model).toEqual(base.agents.defaults.model);
  });

  it("ignores undefined deletions under blocked __proto__ keys without mutating input", () => {
    const blockedKey = "__proto__";
    const config = { [blockedKey]: { retained: "before" } };
    const baseLocal = pluginPatch(config) satisfies OpenClawConfig;
    const patch = pluginPatch({ [blockedKey]: { retained: undefined } });

    const next = applyAuthPatch(baseLocal, patch);

    expect(config[blockedKey]).toEqual({ retained: "before" });
    expect(next.plugins?.entries?.example?.config?.[blockedKey]).toEqual({ retained: "before" });
  });

  it("drops prototype-pollution keys from opt-in model replacement", () => {
    const patch = JSON.parse(
      '{"agents":{"defaults":{"models":{"__proto__":{"polluted":true},"claude-cli/claude-sonnet-4-6":{"alias":"Sonnet","params":{"constructor":{"polluted":true},"maxTokens":12000}}}}}}',
    );
    const next = applyAuthPatch(base, patch, {
      replaceDefaultModels: true,
    });
    const models = next.agents?.defaults?.models;
    expect(models).toEqual({
      "claude-cli/claude-sonnet-4-6": {
        alias: "Sonnet",
        params: { maxTokens: 12000 },
      },
    });
    expect(Object.hasOwn(models ?? {}, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(Object.assign({}, models)).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("deletes provider auth fields marked undefined by auth patches", () => {
    const baseLocal = providerPatch({
      "microsoft-foundry": {
        baseUrl: "https://example.services.ai.azure.com/openai/v1",
        api: "anthropic-messages",
        authHeader: false,
        apiKey: "FOUNDRY_API_KEY",
        headers: { "api-key": "FOUNDRY_API_KEY" },
        models: [],
      },
    } satisfies Record<string, ModelProviderConfig>);
    const patch: ProviderAuthResult["configPatch"] = providerPatch({
      "microsoft-foundry": {
        authHeader: true,
        apiKey: undefined,
        headers: undefined,
      },
    });

    const next = applyAuthPatch(baseLocal, patch, normalization);
    const provider = next.models?.providers?.["microsoft-foundry"];

    expect(provider).toMatchObject({ authHeader: true });
    expect(provider).not.toHaveProperty("apiKey");
    expect(provider).not.toHaveProperty("headers");
  });

  it("deletes individual auth headers while retaining other provider headers", () => {
    const provider = {
      baseUrl: "https://provider.example/v1",
      headers: { Authorization: "Bearer old-key", "X-Deployment": "keep" },
      request: { headers: { "X-Custom-Auth": "old-key", "X-Route": "keep" } },
      models: [],
    };
    const patch: ProviderAuthResult["configPatch"] = providerPatch({
      fixture: {
        headers: { Authorization: undefined },
        request: { headers: { "X-Custom-Auth": undefined } },
      },
    });
    const next = applySdkAuthPatch(providerPatch({ fixture: provider }), patch);
    expect(next.models?.providers?.fixture).toMatchObject({
      baseUrl: provider.baseUrl,
      models: provider.models,
    });
    expect(next.models?.providers?.fixture?.headers).toEqual({ "X-Deployment": "keep" });
    expect(next.models?.providers?.fixture?.request?.headers).toEqual({ "X-Route": "keep" });
  });

  it("accepts authored config input without materializing unrelated providers", () => {
    const materialized: OpenClawConfig = {
      models: { providers: { fixture: { baseUrl: "https://provider.example/v1", models: [] } } },
    };
    const fullResult: ProviderAuthResult = { profiles: [], configPatch: materialized };
    expect(applySdkAuthPatch({}, fullResult.configPatch).models?.providers?.fixture).toMatchObject(
      materialized.models!.providers!.fixture!,
    );
    const config: OpenClawConfigInput = {
      models: {
        providers: {
          fixture: { baseUrl: "https://provider.example/v1", models: [] },
          unrelated: { apiKey: "synthetic-unrelated-key" },
        },
      },
    };
    const result: ProviderAuthResult = { profiles: [], configPatch: config };
    const next = applySdkAuthPatch({}, result.configPatch);
    expect(next.models?.providers?.fixture?.baseUrl).toBe("https://provider.example/v1");
    expect(next.models?.providers?.unrelated?.apiKey).toBe("synthetic-unrelated-key");
    expect(config.models?.providers?.unrelated).toEqual({ apiKey: "synthetic-unrelated-key" });
  });

  it.each(["litellm", "LiteLLM"] as const)(
    "preserves fresh %s fields and canonical unchanged fields from a whole-config auth result",
    (updatedKey) => {
      const localModel = model({ id: "local-model", name: "Local model" });
      const modelRows = (params: Record<string, unknown>) => [{ ...localModel, params }];
      const canonical: ModelProviderConfig = {
        baseUrl: "https://canonical.example/v1",
        apiKey: "canonical-key",
        headers: { "x-old": "remove" },
        params: { canonicalKeep: true, shared: "canonical" },
        models: modelRows({ canonicalValue: null, shared: "canonical" }),
      };
      const alias: ModelProviderConfig = {
        baseUrl: "https://alias.example/v1",
        apiKey: "alias-key",
        params: { aliasKeep: true, shared: "alias" },
        request: { headers: { "x-route": "keep" } },
        models: modelRows({
          aliasValue: null,
          shared: "alias",
          rows: [{ id: "same", stale: true }],
        }),
      };
      const baseLocal = providerPatch({ litellm: canonical, LiteLLM: alias });
      const sourceRow = baseLocal.models.providers[updatedKey];
      // Auth plugins may return the whole config, including unchanged duplicate rows.
      const patch = providerPatch({
        ...baseLocal.models.providers,
        [updatedKey]: {
          ...sourceRow,
          baseUrl: "https://selected.example/v1",
          apiKey: "selected-key",
          headers: undefined,
          params: { ...sourceRow.params, selected: true },
          models: modelRows({
            ...sourceRow.models[0]?.params,
            selectedValue: null,
            rows: [{ id: "same", selected: true }],
          }),
        },
      });

      const next = applyAuthPatch(baseLocal, patch, normalization);

      expect(next.models?.providers).toEqual({
        litellm: {
          baseUrl: "https://selected.example/v1",
          apiKey: "selected-key",
          params: { canonicalKeep: true, aliasKeep: true, shared: "canonical", selected: true },
          request: alias.request,
          models: modelRows({
            canonicalValue: null,
            aliasValue: null,
            shared: "canonical",
            selectedValue: null,
            rows: [{ id: "same", selected: true }],
          }),
        },
      });
    },
  );

  it("normalizes retired Google Gemini per-agent refs from provider config patches", () => {
    const agent = {
      model: { primary: retiredGemini, fallbacks: [retiredGemini] },
      models: { [retiredGemini]: { alias: "ops-gemini" } },
    };
    const next = applyAuthPatch({}, { agents: { entries: { ops: agent } } });

    expect(next.agents?.entries?.ops).toEqual({
      model: { primary: currentGemini, fallbacks: [currentGemini] },
      models: { [currentGemini]: { alias: "ops-gemini" } },
    });
  });

  it.each(["google", "kilocode"])(
    "normalizes retired Gemini catalog rows from %s config patches",
    (provider) => {
      const patch = providerPatch({
        [provider]: {
          baseUrl: "https://provider.example/v1",
          api: "openai-completions",
          models: [model()],
        },
      } satisfies Record<string, ModelProviderConfig>);
      const next = applyAuthPatch({}, patch, normalization);
      expect(next.models?.providers?.[provider]?.models?.[0]?.id).toBe(currentGemini);
      expect(next.models?.providers?.[provider]?.api).toBe("openai-completions");
    },
  );
});
