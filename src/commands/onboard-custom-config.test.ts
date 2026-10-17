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
function providerConfig(
  provider: Pick<ModelProviderConfig, "baseUrl"> & Partial<ModelProviderConfig>,
  id = "custom",
): OpenClawConfig {
  return {
    models: { providers: { [id]: { api: "openai-completions", models: [], ...provider } } },
  };
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

function buildCustomProviderConfig(contextWindow: number) {
  return providerConfig({
    baseUrl: customBaseUrl,
    models: [
      configuredModel("foo-large", {
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
  });

  expect(result.config.agents?.entries?.OPS?.model).toEqual({ primary: "custom/foo-large" });
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
  try {
    for (const [raw, provider, model, expected] of [
      ["Operations", "custom", "new-model", "Alias Operations already points to openai/ops."],
      ["Global", "custom", "new-model", "Alias Global already points to anthropic/global."],
      ["Operations", "openai", "ops", undefined],
      ["Legacy", "custom", "modern-model", undefined],
      ["Canonical", "custom", "latest", undefined],
    ] as const) {
      expect(
        resolveCustomModelAliasError({
          raw,
          cfg,
          agentId: "ops",
          modelRef: { provider, model },
          manifestPlugins,
        }),
      ).toBe(expected);
    }
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

it.each([
  {
    host: "openai",
    modelId: "gpt-4.1",
    path: "/openai/v1/responses",
    body: { model: "gpt-4.1", input: "Hi", max_output_tokens: 16, stream: false },
  },
  {
    host: "services.ai",
    modelId: "deepseek-v3-0324",
    path: "/openai/deployments/deepseek-v3-0324/chat/completions?api-version=2024-10-21",
    body: {
      model: "deepseek-v3-0324",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 16,
      stream: false,
    },
  },
])("uses Azure $host verification endpoint, headers, and body", ({ host, modelId, path, body }) => {
  const request = buildOpenAiVerificationProbeRequest({
    baseUrl: `https://my-resource.${host}.azure.com`,
    apiKey: "azure-test-key",
    modelId,
  });
  expect(request.endpoint).toBe(`https://my-resource.${host}.azure.com${path}`);
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
    [
      { baseUrl: "ftp://localhost/v1" },
      "Custom provider base URL must be a valid HTTP or HTTPS URL.",
    ],
    [{ baseUrl: "not-a-url" }, "Custom provider base URL must be a valid HTTP or HTTPS URL."],
    [{ providerId: "!!!" }, "Custom provider ID must include letters, numbers, or hyphens."],
  ] as const)("rejects invalid custom config %j", (params, message) => {
    expect(() => applyCustom(params)).toThrow(message);
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
    const provider = result.config.models?.providers?.[result.providerId!];

    expect(provider?.baseUrl).toBe("https://my-resource.openai.azure.com/openai/v1");
  });

  it.each([
    { baseUrl: "https://claude-compatible.example.ts.net", compatibility: "anthropic" },
    { baseUrl: "https://resource.openai.azure.com", compatibility: "openai" },
    { baseUrl: "https://llm.example.com/v1", compatibility: "openai-responses" },
  ] as const)("rejects no-auth on $baseUrl before saving", ({ baseUrl, compatibility }) => {
    expect(() =>
      applyCustomApiConfig({
        ...parseFlags({ baseUrl, modelId: "some-model", compatibility, noAuth: true }),
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
      config: providerConfig({ baseUrl: model.baseUrl, api: "openai-responses", models: [model] }),
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

  it.each([
    ["new no-auth", undefined, true, undefined, "none", undefined],
    [
      "stale-key to no-auth",
      { auth: "api-key", apiKey: "stale-key" },
      true,
      undefined,
      "none",
      undefined,
    ],
    ["no-auth to key", { auth: "none" }, undefined, "fresh-key", undefined, "fresh-key"],
  ] as const)("persists auth transition: %s", (_name, existing, noAuth, apiKey, auth, key) => {
    const providerId = "custom-studio-example-ts-net";
    const result = applyCustom({
      config: existing
        ? providerConfig(
            {
              baseUrl: "https://studio.example.ts.net/v1",
              ...existing,
            },
            providerId,
          )
        : {},
      baseUrl: "https://studio.example.ts.net/v1",
      modelId: "qwen3.8",
      noAuth,
      apiKey,
      providerId: existing ? providerId : undefined,
    });
    const provider = result.config.models?.providers?.[result.providerId!];
    expect(provider?.auth).toBe(auth);
    expect(provider?.apiKey).toBe(key);
  });

  it("re-onboard updates existing Azure provider instead of creating a duplicate", () => {
    const oldProviderId = "custom-my-resource-openai-azure-com";
    const result = applyCustom({
      config: providerConfig(
        {
          baseUrl: "https://my-resource.openai.azure.com/openai/deployments/gpt-4",
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
    expect(model?.contextWindow).toBe(128_000);
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
      expect(parseFlags({ modelId: undefined, compatibility })).toEqual({
        baseUrl: "https://llm.example.com/v1",
        modelId: "",
        compatibility,
      });
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
    expect(parseFlags({ supportsImageInput: true }).supportsImageInput).toBe(true);
  });

  it("parses OpenAI Responses compatibility", () => {
    expect(
      parseFlags({ modelId: "gpt-5.4", compatibility: "openai-responses" }).compatibility,
    ).toBe("openai-responses");
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
