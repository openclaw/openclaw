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
import { createTestModelDefinition } from "./test-runtime-config-helpers.js";

const EXPECTED_CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const customBaseUrl = "https://llm.example.com/v1";
const opsTarget = {
  agentId: "ops",
  agentDir: "/tmp/ops-agent",
  workspaceDir: "/tmp/ops-workspace",
};
function applyCustom(overrides: Partial<Parameters<typeof applyCustomApiConfig>[0]> = {}) {
  return applyCustomApiConfig({
    config: {},
    baseUrl: customBaseUrl,
    modelId: "foo-large",
    compatibility: "openai",
    ...overrides,
  });
}
function configuredProvider(provider: ModelProviderConfig, id = "custom"): OpenClawConfig {
  return { models: { providers: { [id]: provider } } };
}
function parseFlags(overrides: Parameters<typeof parseNonInteractiveCustomApiFlags>[0]) {
  return parseNonInteractiveCustomApiFlags({
    baseUrl: customBaseUrl,
    modelId: "foo-large",
    ...overrides,
  });
}
const manifestPlugins = [
  {
    modelIdNormalization: {
      providers: {
        custom: {
          aliases: {
            latest: "modern-model",
          },
        },
      },
    },
  },
] satisfies Array<Pick<PluginManifestRecord, "modelIdNormalization">>;

function buildCustomProviderConfig(contextWindow: number) {
  return configuredProvider({
    api: "openai-completions",
    baseUrl: customBaseUrl,
    models: [
      createTestModelDefinition("foo-large", {
        contextWindow,
        maxTokens: contextWindow > CONTEXT_WINDOW_HARD_MIN_TOKENS ? 4096 : 1024,
      }),
    ],
  });
}

it("keeps explicit custom-provider model state on its authored owner", () => {
  const result = applyCustom({
    config: {
      agents: {
        ownership: "explicit",
        defaults: { model: { primary: "anthropic/global" } },
        entries: {
          main: { model: { primary: "anthropic/main" } },
          OPS: { model: { primary: "openai/ops" } },
        },
      },
    },
    providerId: "custom",
    alias: "Custom",
    target: opsTarget,
  });

  expect(result.config.agents?.entries?.OPS?.model).toEqual({ primary: "custom/foo-large" });
  expect(result.config.agents?.entries?.OPS?.models).toEqual({
    "custom/foo-large": { alias: "Custom" },
  });
  expect(result.config.agents?.entries?.main?.model).toEqual({ primary: "anthropic/main" });
  expect(result.config.agents?.defaults?.model).toEqual({ primary: "anthropic/global" });
  expect(result.config.models?.providers?.custom?.models?.map((model) => model.id)).toEqual([
    "foo-large",
  ]);
});

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
      target: opsTarget,
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

it.each([
  {
    host: "openai.azure.com",
    modelId: "gpt-4.1",
    path: "/openai/v1/responses",
    body: { model: "gpt-4.1", input: "Hi", max_output_tokens: 16, stream: false },
  },
  {
    host: "services.ai.azure.com",
    modelId: "deepseek-v3-0324",
    path: "/openai/deployments/deepseek-v3-0324/chat/completions?api-version=2024-10-21",
    body: {
      model: "deepseek-v3-0324",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 16,
      stream: false,
    },
  },
])("builds the $host verification request", ({ host, modelId, path, body }) => {
  const request = buildOpenAiVerificationProbeRequest({
    baseUrl: `https://my-resource.${host}`,
    apiKey: "azure-test-key",
    modelId,
  });
  expect(request.endpoint).toBe(`https://my-resource.${host}${path}`);
  expect(request.headers["api-key"]).toBe("azure-test-key");
  expect(request.headers.Authorization).toBeUndefined();
  expect(request.body).toEqual(body);
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
    ["ftp://localhost/v1", undefined],
    ["not-a-url", undefined],
    [customBaseUrl, "!!!"],
  ])("rejects invalid endpoint %s or provider %s", (baseUrl, providerId) => {
    expect(() => applyCustom({ baseUrl, providerId })).toThrow(
      providerId
        ? "Custom provider ID must include letters, numbers, or hyphens."
        : "Custom provider base URL must be a valid HTTP or HTTPS URL.",
    );
  });

  const azureUrl = "https://my-resource.openai.azure.com";
  const azureId = "custom-my-resource-openai-azure-com";
  it.each<{
    name: string;
    modelId: string;
    path?: string;
    config?: OpenClawConfig;
    thinking?: string;
    newReasoning?: boolean;
  }>([
    { name: "reasoning defaults", modelId: "o4-mini", thinking: "medium", newReasoning: true },
    { name: "deployment URL normalization", modelId: "gpt-4", path: "/openai/deployments/gpt-4" },
    {
      name: "existing provider reuse",
      modelId: "gpt-4",
      config: configuredProvider(
        {
          baseUrl: azureUrl + "/openai/deployments/gpt-4",
          api: "openai-completions",
          models: [createTestModelDefinition("gpt-4", { contextWindow: 1, maxTokens: 1 })],
        },
        azureId,
      ),
    },
    {
      name: "authored thinking",
      modelId: "o3-mini",
      thinking: "high",
      config: {
        agents: {
          defaults: { models: { [azureId + "/o3-mini"]: { params: { thinking: "high" } } } },
        },
      },
    },
  ])(
    "applies Azure config with $name",
    ({ modelId, path = "", config = {}, thinking, newReasoning }) => {
      const result = applyCustom({
        config,
        baseUrl: azureUrl + path,
        modelId,
        apiKey: "azure-key",
      });
      expect(result.providerId).toBe(azureId);
      expect(result.providerIdRenamedFrom).toBeUndefined();
      const provider = result.config.models?.providers?.[azureId];
      expect(provider).toMatchObject({
        baseUrl: azureUrl + "/openai/v1",
        api: "azure-openai-responses",
        authHeader: false,
        headers: { "api-key": "azure-key" },
      });
      if (newReasoning) {
        expect(provider?.models.find((model) => model.id === modelId)).toMatchObject({
          contextWindow: 400_000,
          maxTokens: 16_384,
          input: ["text", "image"],
          reasoning: true,
          compat: { supportsStore: false },
        });
      }
      if (thinking) {
        expect(
          result.config.agents?.defaults?.models?.[azureId + "/" + modelId]?.params?.thinking,
        ).toBe(thinking);
      }
    },
  );

  it.each([
    { baseUrl: "https://claude-compatible.example.ts.net", compatibility: "anthropic" },
    { baseUrl: "https://resource.openai.azure.com", compatibility: "openai" },
    { baseUrl: "https://llm.example.com/v1", compatibility: "openai-responses" },
  ] as const)("rejects no-auth on $baseUrl before saving", ({ baseUrl, compatibility }) => {
    expect(() =>
      applyCustom({
        ...parseFlags({
          baseUrl,
          modelId: "some-model",
          compatibility,
          noAuth: true,
        }),
      }),
    ).toThrow(/auth: "none"/);
  });

  it("accepts no-auth flags when the selected model overrides Responses with Completions", () => {
    const model = makeProviderModelFixture<"openai-completions">({
      provider: "custom",
      id: "foo-large",
      baseUrl: customBaseUrl,
      api: "openai-completions",
    });
    const result = applyCustom({
      ...parseFlags({
        baseUrl: model.baseUrl,
        modelId: model.id,
        providerId: "custom",
        compatibility: "openai-responses",
        noAuth: true,
      }),
      config: configuredProvider({
        baseUrl: model.baseUrl,
        api: "openai-responses",
        models: [model],
      }),
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
        baseUrl: customBaseUrl,
        api: "openai-completions",
        auth: "none",
        models: [
          createTestModelDefinition("foo-large", {
            api: "openai-responses",
            contextWindow: 128_000,
          }),
        ],
      } satisfies ModelProviderConfig;
      expect(() =>
        applyCustom({
          config: configuredProvider(provider),
          baseUrl: provider.baseUrl,
          providerId: "custom",
          noAuth,
        }),
      ).toThrow(/auth: "none"/);
    },
  );

  it.each<{
    name: string;
    existing?: Partial<ModelProviderConfig>;
    noAuth?: boolean;
    apiKey?: string;
    auth?: string;
    savedKey?: string;
  }>([
    { name: "new no-auth provider", noAuth: true, auth: "none" },
    {
      name: "key to no-auth",
      existing: { auth: "api-key", apiKey: "stale-key" },
      noAuth: true,
      auth: "none",
    },
    {
      name: "no-auth to key",
      existing: { auth: "none" },
      apiKey: "fresh-key",
      savedKey: "fresh-key",
    },
  ])("persists the $name transition", ({ existing, noAuth, apiKey, auth, savedKey }) => {
    const result = applyCustom({
      ...parseFlags({ noAuth, apiKey }),
      providerId: "custom",
      config: existing
        ? configuredProvider({
            baseUrl: customBaseUrl,
            api: "openai-completions",
            models: [],
            ...existing,
          })
        : {},
    });
    const provider = result.config.models?.providers?.custom;
    expect(provider?.auth).toBe(auth);
    expect(provider?.apiKey).toBe(savedKey);
  });

  it("renames provider id when a non-azure baseUrl differs", () => {
    const result = applyCustom({
      config: configuredProvider({
        baseUrl: "http://old.example.com/v1",
        api: "openai-completions",
        models: [
          createTestModelDefinition("old-model", { name: "Old", contextWindow: 1, maxTokens: 1 }),
        ],
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
      ...parseFlags({ supportsImageInput: true }),
      config: buildCustomProviderConfig(CONTEXT_WINDOW_HARD_MIN_TOKENS),
      providerId: "custom",
    });
    const model = result.config.models?.providers?.custom?.models?.find(
      (entry) => entry.id === "foo-large",
    );

    expect(model?.input).toEqual(["text", "image"]);
    expect(model?.contextWindow).toBe(EXPECTED_CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW_TOKENS);
  });
});

describe("parseNonInteractiveCustomApiFlags", () => {
  it("parses required flags and defaults compatibility to openai", () => {
    const result = parseFlags({
      baseUrl: " https://llm.example.com/v1 ",
      modelId: " foo-large ",
      apiKey: " custom-test-key ",
      providerId: " my-custom ",
    });

    expect(result).toEqual({
      baseUrl: customBaseUrl,
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
