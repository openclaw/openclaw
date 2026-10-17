// Onboard custom config tests cover provider-specific config merging and context-window bounds.
import { setCurrentManifestModelIdNormalizationPolicies } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { describe, expect, it, vi } from "vitest";
import { CONTEXT_WINDOW_HARD_MIN_TOKENS } from "../agents/context-window-guard.js";
import * as providerModelNormalizationRuntime from "../agents/provider-model-normalization.runtime.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import * as currentPluginMetadataSnapshot from "../plugins/current-plugin-metadata-snapshot.js";
import * as manifestContractEligibility from "../plugins/manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import {
  applyCustomApiConfig,
  buildAnthropicVerificationProbeRequest,
  buildOpenAiVerificationProbeRequest,
  parseNonInteractiveCustomApiFlags,
  resolveCustomModelAliasError,
} from "./onboard-custom-config.js";

const EXPECTED_CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const manifestPlugins = [
  {
    modelIdNormalization: { providers: { custom: { aliases: { latest: "modern-model" } } } },
  },
] satisfies Array<Pick<PluginManifestRecord, "modelIdNormalization">>;
const customBaseUrl = "https://llm.example.com/v1";
const target = { agentId: "ops", agentDir: "/tmp/ops-agent", workspaceDir: "/tmp/ops-workspace" };
function applyCustom(overrides: Partial<Parameters<typeof applyCustomApiConfig>[0]> = {}) {
  return applyCustomApiConfig({
    config: {},
    baseUrl: customBaseUrl,
    modelId: "foo-large",
    compatibility: "openai",
    ...overrides,
  });
}
function parseFlags(
  overrides: Partial<Parameters<typeof parseNonInteractiveCustomApiFlags>[0]> = {},
) {
  return parseNonInteractiveCustomApiFlags({
    baseUrl: customBaseUrl,
    modelId: "foo-large",
    ...overrides,
  });
}
function providerConfig(provider: ModelProviderConfig, id = "custom"): OpenClawConfig {
  return { models: { providers: { [id]: provider } } };
}
function configuredModel(
  id = "foo-large",
  overrides: Partial<ModelProviderConfig["models"][number]> = {},
) {
  return {
    id,
    name: id,
    contextWindow: 1,
    maxTokens: 1,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    ...overrides,
  };
}

function buildCustomProviderConfig(contextWindow?: number) {
  if (contextWindow === undefined) {
    return {} as OpenClawConfig;
  }
  return providerConfig({
    api: "openai-completions",
    baseUrl: customBaseUrl,
    models: [
      configuredModel("foo-large", {
        contextWindow,
        maxTokens: contextWindow > CONTEXT_WINDOW_HARD_MIN_TOKENS ? 4096 : 1024,
      }),
    ],
  });
}

it.each([{ setAsPrimary: undefined, expectedPrimary: "custom/foo-large" }])(
  "keeps explicit custom-provider model state on its authored owner ($setAsPrimary)",
  ({ setAsPrimary, expectedPrimary }) => {
    const result = applyCustom({
      config: {
        agents: {
          ownership: "explicit",
          defaults: {
            systemAgent: { agentId: "ops" },
            model: { primary: "anthropic/global" },
            models: { "anthropic/global": { alias: "Global" } },
          },
          entries: {
            main: { model: { primary: "anthropic/main" } },
            OPS: {
              model: { primary: "openai/ops" },
              models: { "openai/ops": { alias: "Operations" } },
              modelPolicy: { allow: ["openai/ops"] },
            },
          },
        },
      },
      providerId: "custom",
      alias: "Custom",
      target,
      setAsPrimary,
    });

    expect(result.config.agents?.entries?.OPS?.model).toEqual({ primary: expectedPrimary });
    expect(result.config.agents?.entries?.OPS?.models).toEqual({
      "openai/ops": { alias: "Operations" },
      "custom/foo-large": { alias: "Custom" },
    });
    expect(result.config.agents?.entries?.OPS?.modelPolicy).toEqual({ allow: ["openai/ops"] });
    expect(result.config.agents?.entries?.main?.model).toEqual({ primary: "anthropic/main" });
    expect(result.config.agents?.defaults?.model).toEqual({ primary: "anthropic/global" });
    expect(result.config.agents?.defaults?.models).toEqual({
      "anthropic/global": { alias: "Global" },
    });
    expect(result.config.models?.providers?.custom?.models?.map((model) => model.id)).toEqual([
      "foo-large",
    ]);
  },
);

it("rejects custom aliases already used by the selected agent", () => {
  expect(() =>
    applyCustom({
      config: {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "ops" } },
          entries: { ops: { models: { "openai/ops": { alias: "Operations" } } } },
        },
      },
      providerId: "custom",
      alias: "Operations",
      target,
    }),
  ).toThrow("Alias Operations already points to openai/ops.");
});

it("validates authored and inherited aliases without discovering plugin metadata", () => {
  setCurrentManifestModelIdNormalizationPolicies(undefined);
  const currentSnapshot = vi
    .spyOn(currentPluginMetadataSnapshot, "getCurrentPluginMetadataSnapshot")
    .mockImplementation(() => {
      throw new Error("authored alias validation must not inspect plugin metadata");
    });
  const loadedSnapshot = vi
    .spyOn(manifestContractEligibility, "loadManifestMetadataSnapshot")
    .mockImplementation(() => {
      throw new Error("authored alias validation must not load plugin metadata");
    });
  const runtimeNormalization = vi
    .spyOn(providerModelNormalizationRuntime, "normalizeProviderModelIdWithRuntime")
    .mockImplementation(() => {
      throw new Error("authored alias validation must not load provider runtime");
    });
  const cfg = {
    agents: {
      defaults: {
        models: {
          "anthropic/global": { alias: "Global" },
          "custom/latest": { alias: "Legacy" },
          "custom/modern-model": { alias: "Canonical" },
        },
      },
      entries: { ops: { models: { "openai/ops": { alias: "Operations" } } } },
    },
  } as OpenClawConfig;
  const aliasError = (raw: string, provider: string, model: string) =>
    resolveCustomModelAliasError({
      raw,
      cfg,
      agentId: "ops",
      modelRef: { provider, model },
      manifestPlugins,
    });

  try {
    expect(aliasError("Operations", "custom", "new-model")).toBe(
      "Alias Operations already points to openai/ops.",
    );
    expect(aliasError("Global", "custom", "new-model")).toBe(
      "Alias Global already points to anthropic/global.",
    );
    expect(aliasError("Operations", "openai", "ops")).toBeUndefined();
    expect(aliasError("Legacy", "custom", "modern-model")).toBeUndefined();
    expect(aliasError("Canonical", "custom", "latest")).toBeUndefined();
  } finally {
    setCurrentManifestModelIdNormalizationPolicies(undefined);
    currentSnapshot.mockRestore();
    loadedSnapshot.mockRestore();
    runtimeNormalization.mockRestore();
  }
});

it("preserves the roster when applying custom-provider model state", () => {
  const result = applyCustom({
    config: {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "ops" } },
        entries: {
          main: { name: "Main" },
          ops: { name: "Operations" },
        },
      },
    },
    providerId: "custom",
    alias: "Custom",
    target,
  });

  expect(result.config.agents).not.toHaveProperty("list");
  expect(result.config.agents?.entries).toEqual({
    main: { name: "Main" },
    ops: {
      name: "Operations",
      model: { primary: "custom/foo-large" },
      models: { "custom/foo-large": { alias: "Custom" } },
    },
  });
  expect(result.config.models?.providers?.custom?.models?.map((model) => model.id)).toEqual([
    "foo-large",
  ]);
});

it("uses azure responses-specific headers and body for openai verification probes", () => {
  const request = buildOpenAiVerificationProbeRequest({
    baseUrl: "https://my-resource.openai.azure.com",
    apiKey: "azure-test-key",
    modelId: "gpt-4.1",
  });

  expect(request.endpoint).toBe("https://my-resource.openai.azure.com/openai/v1/responses");
  expect(request.headers["api-key"]).toBe("azure-test-key");
  expect(request.headers.Authorization).toBeUndefined();
  expect(request.body).toEqual({
    model: "gpt-4.1",
    input: "Hi",
    max_output_tokens: 16,
    stream: false,
  });
});
it("uses Azure Foundry chat-completions probes for services.ai URLs", () => {
  const request = buildOpenAiVerificationProbeRequest({
    baseUrl: "https://my-resource.services.ai.azure.com",
    apiKey: "azure-test-key",
    modelId: "deepseek-v3-0324",
  });

  expect(request.endpoint).toBe(
    "https://my-resource.services.ai.azure.com/openai/deployments/deepseek-v3-0324/chat/completions?api-version=2024-10-21",
  );
  expect(request.headers["api-key"]).toBe("azure-test-key");
  expect(request.headers.Authorization).toBeUndefined();
  expect(request.body).toEqual({
    model: "deepseek-v3-0324",
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 16,
    stream: false,
  });
});
it("uses expanded max_tokens for anthropic verification probes", () => {
  const request = buildAnthropicVerificationProbeRequest({
    baseUrl: "https://example.com",
    apiKey: "test-key",
    modelId: "detected-model",
  });

  expect(request.endpoint).toBe("https://example.com/v1/messages");
  expect(request.body.max_tokens).toBe(1);
});

describe("applyCustomApiConfig", () => {
  it("preserves explicit small context window when already valid", () => {
    const result = applyCustom({ config: buildCustomProviderConfig(8192), providerId: "custom" });
    const model = result.config.models?.providers?.custom?.models?.find(
      (entry) => entry.id === "foo-large",
    );
    expect(model?.contextWindow).toBe(8192);
  });

  it.each([
    ...["ftp://localhost/v1", "not-a-url"].map((baseUrl) => ({
      name: `unsupported base URL ${baseUrl}`,
      params: { baseUrl },
      expectedMessage: "Custom provider base URL must be a valid HTTP or HTTPS URL.",
    })),
    {
      name: "explicit provider ids that normalize to empty",
      params: { providerId: "!!!" },
      expectedMessage: "Custom provider ID must include letters, numbers, or hyphens.",
    },
  ])("rejects $name", ({ params, expectedMessage }) => {
    expect(() => applyCustom(params)).toThrow(expectedMessage);
  });

  it("produces azure-specific config for Azure OpenAI URLs with reasoning model", () => {
    const result = applyCustom({
      baseUrl: "https://user123-resource.openai.azure.com",
      modelId: "o4-mini",
      apiKey: "abcd1234",
    });
    const providerId = result.providerId!;
    const provider = result.config.models?.providers?.[providerId];

    expect(provider?.baseUrl).toBe("https://user123-resource.openai.azure.com/openai/v1");
    expect(provider?.api).toBe("azure-openai-responses");
    expect(provider?.authHeader).toBe(false);
    expect(provider?.headers).toEqual({ "api-key": "abcd1234" });

    const model = provider?.models?.find((m) => m.id === "o4-mini");
    expect(Object.entries(model ?? {})).toEqual([
      ["id", "o4-mini"],
      ["name", "o4-mini (Custom Provider)"],
      ["contextWindow", 400_000],
      ["maxTokens", 16_384],
      ["input", ["text", "image"]],
      ["cost", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
      ["reasoning", true],
      ["compat", { supportsStore: false }],
    ]);

    const modelRef = `${providerId}/${result.modelId}`;
    expect(result.config.agents?.defaults?.models?.[modelRef]?.params?.thinking).toBe("medium");
  });

  it("strips pre-existing deployment path from Azure URL in stored config", () => {
    const result = applyCustom({
      baseUrl: "https://my-resource.openai.azure.com/openai/deployments/gpt-4",
      modelId: "gpt-4",
      apiKey: "key456",
    });
    const providerId = result.providerId!;
    const provider = result.config.models?.providers?.[providerId];

    expect(provider?.baseUrl).toBe("https://my-resource.openai.azure.com/openai/v1");
  });

  it("persists auth none for no-auth custom endpoints", () => {
    const result = applyCustom({
      baseUrl: "https://studio.example.ts.net/v1",
      modelId: "qwen3.8",
      noAuth: true,
    });
    const provider = result.config.models?.providers?.[result.providerId!];

    expect(provider?.auth).toBe("none");
    expect(provider?.apiKey).toBeUndefined();
  });

  it.each([
    { baseUrl: "https://claude-compatible.example.ts.net", compatibility: "anthropic" },
    { baseUrl: "https://resource.openai.azure.com", compatibility: "openai" },
    { baseUrl: "https://llm.example.com/v1", compatibility: "openai-responses" },
  ] as const)("rejects no-auth on $baseUrl before saving", ({ baseUrl, compatibility }) => {
    expect(() =>
      applyCustomApiConfig({
        ...parseNonInteractiveCustomApiFlags({
          baseUrl,
          modelId: "some-model",
          compatibility,
          noAuth: true,
        }),
        config: {},
      }),
    ).toThrow(/auth: "none"/);
  });

  it("accepts no-auth flags when the selected model overrides Responses with Completions", () => {
    const model = makeProviderModelFixture<"openai-completions">({
      provider: "custom",
      id: "foo-large",
      baseUrl: "https://llm.example.com/v1",
      api: "openai-completions",
    });
    const result = applyCustomApiConfig({
      ...parseNonInteractiveCustomApiFlags({
        baseUrl: model.baseUrl,
        modelId: model.id,
        providerId: "custom",
        compatibility: "openai-responses",
        noAuth: true,
      }),
      config: {
        models: {
          providers: {
            custom: { baseUrl: model.baseUrl, api: "openai-responses", models: [model] },
          },
        },
      },
    });
    expect(result.config.models?.providers?.custom).toMatchObject({
      api: "openai-responses",
      auth: "none",
      models: [{ id: model.id, api: "openai-completions" }],
    });
  });

  it.each([true, false])(
    "rejects a Responses model override with explicit no-auth: %s",
    (noAuth) => {
      const provider = {
        baseUrl: "https://llm.example.com/v1",
        api: "openai-completions",
        auth: "none",
        models: [
          configuredModel("foo-large", {
            api: "openai-responses",
            contextWindow: 128_000,
            maxTokens: 4096,
          }),
        ],
      } satisfies ModelProviderConfig;
      expect(() =>
        applyCustom({
          config: providerConfig(provider),
          baseUrl: provider.baseUrl,
          providerId: "custom",
          noAuth,
        }),
      ).toThrow(/auth: "none"/);
    },
  );

  it("clears stale keys and auth modes when switching a provider to no-auth", () => {
    const providerId = "custom-studio-example-ts-net";
    const result = applyCustom({
      config: providerConfig(
        {
          baseUrl: "https://studio.example.ts.net/v1",
          api: "openai-completions",
          auth: "api-key",
          apiKey: "stale-key",
          models: [],
        },
        providerId,
      ),
      baseUrl: "https://studio.example.ts.net/v1",
      modelId: "qwen3.8",
      noAuth: true,
      providerId,
    });
    const provider = result.config.models?.providers?.[providerId];

    expect(provider?.auth).toBe("none");
    expect(provider?.apiKey).toBeUndefined();
  });

  it("clears a previous auth none when a real key is supplied later", () => {
    const providerId = "custom-studio-example-ts-net";
    const result = applyCustom({
      config: providerConfig(
        {
          baseUrl: "https://studio.example.ts.net/v1",
          api: "openai-completions",
          auth: "none",
          models: [],
        },
        providerId,
      ),
      baseUrl: "https://studio.example.ts.net/v1",
      modelId: "qwen3.8",
      apiKey: "fresh-key",
      providerId,
    });
    const provider = result.config.models?.providers?.[providerId];

    expect(provider?.auth).toBeUndefined();
    expect(provider?.apiKey).toBe("fresh-key");
  });

  it("re-onboard updates existing Azure provider instead of creating a duplicate", () => {
    const oldProviderId = "custom-my-resource-openai-azure-com";
    const result = applyCustom({
      config: providerConfig(
        {
          baseUrl: "https://my-resource.openai.azure.com/openai/deployments/gpt-4",
          api: "openai-completions",
          models: [configuredModel("gpt-4")],
        },
        oldProviderId,
      ),
      baseUrl: "https://my-resource.openai.azure.com",
      modelId: "gpt-4",
      apiKey: "key789",
    });

    expect(result.providerId).toBe(oldProviderId);
    expect(result.providerIdRenamedFrom).toBeUndefined();
    const provider = result.config.models?.providers?.[oldProviderId];
    expect(provider?.baseUrl).toBe("https://my-resource.openai.azure.com/openai/v1");
    expect(provider?.api).toBe("azure-openai-responses");
    expect(provider?.authHeader).toBe(false);
    expect(provider?.headers).toEqual({ "api-key": "key789" });
  });

  it("renames provider id when a non-azure baseUrl differs", () => {
    const result = applyCustom({
      config: providerConfig({
        baseUrl: "http://old.example.com/v1",
        api: "openai-completions",
        models: [configuredModel("old-model", { name: "Old" })],
      }),
      baseUrl: "http://localhost:11434/v1",
      modelId: "llama3",
      providerId: "custom",
    });

    expect(result.providerId).toBe("custom-2");
    expect(Object.keys(result.config.models?.providers ?? {}).toSorted()).toEqual([
      "custom",
      "custom-2",
    ]);
    const provider = result.config.models?.providers?.["custom-2"];
    expect(provider?.baseUrl).toBe("http://localhost:11434/v1");
    expect(provider?.models?.[0]?.id).toBe("llama3");
  });

  it("updates existing non-azure custom model input when image support is explicitly requested", () => {
    const result = applyCustom({
      config: buildCustomProviderConfig(CONTEXT_WINDOW_HARD_MIN_TOKENS),
      providerId: "custom",
      supportsImageInput: true,
    });
    const model = result.config.models?.providers?.custom?.models?.find(
      (entry) => entry.id === "foo-large",
    );

    expect(model?.input).toEqual(["text", "image"]);
    expect(model?.contextWindow).toBe(EXPECTED_CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  it("preserves existing per-model thinking when already set for azure reasoning model", () => {
    const providerId = "custom-my-resource-openai-azure-com";
    const modelRef = `${providerId}/o3-mini`;
    const result = applyCustom({
      config: {
        agents: { defaults: { models: { [modelRef]: { params: { thinking: "high" } } } } },
      } as OpenClawConfig,
      baseUrl: "https://my-resource.openai.azure.com",
      modelId: "o3-mini",
      apiKey: "key",
    });
    expect(result.config.agents?.defaults?.models?.[modelRef]?.params?.thinking).toBe("high");
  });
});

describe("parseNonInteractiveCustomApiFlags", () => {
  it("parses required flags and defaults compatibility to openai", () => {
    const result = parseNonInteractiveCustomApiFlags({
      baseUrl: " https://llm.example.com/v1 ",
      modelId: " foo-large ",
      apiKey: " custom-test-key ",
      providerId: " my-custom ",
    });

    expect(result).toEqual({
      baseUrl: "https://llm.example.com/v1",
      modelId: "foo-large",
      compatibility: "openai",
      apiKey: "custom-test-key", // pragma: allowlist secret
      providerId: "my-custom",
    });
  });

  it.each(["openai", "openai-responses"])(
    "allows omitted model ids for %s discovery",
    (compatibility) => {
      expect(
        parseFlags({
          modelId: undefined,
          compatibility,
        }),
      ).toEqual({ baseUrl: "https://llm.example.com/v1", modelId: "", compatibility });
    },
  );

  it("requires an explicit model id for Anthropic compatibility", () => {
    expect(() =>
      parseFlags({
        baseUrl: "https://llm.example.com",
        modelId: undefined,
        compatibility: "anthropic",
      }),
    ).toThrow("--custom-model-id");
  });

  it("parses custom image input opt-in", () => {
    const result = parseFlags({ supportsImageInput: true });
    expect(result.supportsImageInput).toBe(true);
  });

  it("parses OpenAI Responses compatibility", () => {
    const result = parseFlags({ modelId: "gpt-5.4", compatibility: "openai-responses" });
    expect(result.compatibility).toBe("openai-responses");
  });

  it("parses the no-auth opt-in", () => {
    const result = parseFlags({ noAuth: true });
    expect(result.noAuth).toBe(true);
    expect(result.apiKey).toBeUndefined();
  });

  it("rejects no-auth combined with an API key", () => {
    expect(() =>
      parseFlags({
        apiKey: "custom-test-key", // pragma: allowlist secret
        noAuth: true,
      }),
    ).toThrow("--custom-no-auth cannot be combined with --custom-api-key");
  });

  it("rejects invalid compatibility values", () => {
    expect(() => parseFlags({ compatibility: "xmlrpc" })).toThrow(
      'Invalid --custom-compatibility (use "openai", "openai-responses", or "anthropic").',
    );
  });
});
