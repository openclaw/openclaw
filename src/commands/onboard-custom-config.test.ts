// Onboard custom config tests cover provider-specific config merging and context-window bounds.
import { setCurrentManifestModelIdNormalizationPolicies } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { describe, expect, it, vi } from "vitest";
import { CONTEXT_WINDOW_HARD_MIN_TOKENS } from "../agents/context-window-guard.js";
import * as providerModelNormalizationRuntime from "../agents/provider-model-normalization.runtime.js";
import type { OpenClawConfig } from "../config/config.js";
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

function buildCustomProviderConfig(contextWindow?: number) {
  if (contextWindow === undefined) {
    return {} as OpenClawConfig;
  }
  return {
    models: {
      providers: {
        custom: {
          api: "openai-completions" as const,
          baseUrl: "https://llm.example.com/v1",
          models: [
            {
              id: "foo-large",
              name: "foo-large",
              contextWindow,
              maxTokens: contextWindow > CONTEXT_WINDOW_HARD_MIN_TOKENS ? 4096 : 1024,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              reasoning: false,
            },
          ],
        },
      },
    },
  } as OpenClawConfig;
}

function applyCustomModelConfigWithContextWindow(contextWindow?: number) {
  return applyCustomApiConfig({
    config: buildCustomProviderConfig(contextWindow),
    baseUrl: "https://llm.example.com/v1",
    modelId: "foo-large",
    compatibility: "openai",
    providerId: "custom",
  });
}

it.each([{ setAsPrimary: undefined, expectedPrimary: "custom/foo-large" }])(
  "keeps explicit custom-provider model state on its authored owner ($setAsPrimary)",
  ({ setAsPrimary, expectedPrimary }) => {
    const result = applyCustomApiConfig({
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
      baseUrl: "https://llm.example.com/v1",
      modelId: "foo-large",
      compatibility: "openai",
      providerId: "custom",
      alias: "Custom",
      target: { agentId: "ops", agentDir: "/tmp/ops-agent", workspaceDir: "/tmp/ops-workspace" },
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
    applyCustomApiConfig({
      config: {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "ops" } },
          entries: { ops: { models: { "openai/ops": { alias: "Operations" } } } },
        },
      },
      baseUrl: "https://llm.example.com/v1",
      modelId: "foo-large",
      compatibility: "openai",
      providerId: "custom",
      alias: "Operations",
      target: { agentId: "ops", agentDir: "/tmp/ops-agent", workspaceDir: "/tmp/ops-workspace" },
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
    expect(
      resolveCustomModelAliasError({
        raw: "Operations",
        cfg,
        agentId: "ops",
        modelRef: { provider: "custom", model: "new-model" },
        manifestPlugins,
      }),
    ).toBe("Alias Operations already points to openai/ops.");
    expect(
      resolveCustomModelAliasError({
        raw: "Global",
        cfg,
        agentId: "ops",
        modelRef: { provider: "custom", model: "new-model" },
        manifestPlugins,
      }),
    ).toBe("Alias Global already points to anthropic/global.");
    expect(
      resolveCustomModelAliasError({
        raw: "Operations",
        cfg,
        agentId: "ops",
        modelRef: { provider: "openai", model: "ops" },
        manifestPlugins,
      }),
    ).toBeUndefined();
    expect(
      resolveCustomModelAliasError({
        raw: "Legacy",
        cfg,
        agentId: "ops",
        modelRef: { provider: "custom", model: "modern-model" },
        manifestPlugins,
      }),
    ).toBeUndefined();
    expect(
      resolveCustomModelAliasError({
        raw: "Canonical",
        cfg,
        agentId: "ops",
        modelRef: { provider: "custom", model: "latest" },
        manifestPlugins,
      }),
    ).toBeUndefined();
  } finally {
    setCurrentManifestModelIdNormalizationPolicies(undefined);
    currentSnapshot.mockRestore();
    loadedSnapshot.mockRestore();
    runtimeNormalization.mockRestore();
  }
});

it("preserves the roster when applying custom-provider model state", () => {
  const result = applyCustomApiConfig({
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
    baseUrl: "https://llm.example.com/v1",
    modelId: "foo-large",
    compatibility: "openai",
    providerId: "custom",
    alias: "Custom",
    target: { agentId: "ops", agentDir: "/tmp/ops-agent", workspaceDir: "/tmp/ops-workspace" },
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
  it.each([
    {
      name: "preserves explicit small context window when already valid",
      existingContextWindow: 8192,
      expectedContextWindow: 8192,
    },
  ])("$name", ({ existingContextWindow, expectedContextWindow }) => {
    const result = applyCustomModelConfigWithContextWindow(existingContextWindow);
    const model = result.config.models?.providers?.custom?.models?.find(
      (entry) => entry.id === "foo-large",
    );
    expect(model?.contextWindow).toBe(expectedContextWindow);
  });

  it.each([
    ...["ftp://localhost/v1", "not-a-url"].map((baseUrl) => ({
      name: `unsupported base URL ${baseUrl}`,
      params: {
        config: {},
        baseUrl,
        modelId: "foo-large",
        compatibility: "openai" as const,
      },
      expectedMessage: "Custom provider base URL must be a valid HTTP or HTTPS URL.",
    })),
    {
      name: "invalid compatibility values at runtime",
      params: {
        config: {},
        baseUrl: "https://llm.example.com/v1",
        modelId: "foo-large",
        compatibility: "invalid" as unknown as "openai",
      },
      expectedMessage:
        'Custom provider compatibility must be "openai", "openai-responses", or "anthropic".',
    },
    {
      name: "explicit provider ids that normalize to empty",
      params: {
        config: {},
        baseUrl: "https://llm.example.com/v1",
        modelId: "foo-large",
        compatibility: "openai" as const,
        providerId: "!!!",
      },
      expectedMessage: "Custom provider ID must include letters, numbers, or hyphens.",
    },
  ])("rejects $name", ({ params, expectedMessage }) => {
    expect(() => applyCustomApiConfig(params)).toThrow(expectedMessage);
  });

  it("produces azure-specific config for Azure OpenAI URLs with reasoning model", () => {
    const result = applyCustomApiConfig({
      config: {},
      baseUrl: "https://user123-resource.openai.azure.com",
      modelId: "o4-mini",
      compatibility: "openai",
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
    const result = applyCustomApiConfig({
      config: {},
      baseUrl: "https://my-resource.openai.azure.com/openai/deployments/gpt-4",
      modelId: "gpt-4",
      compatibility: "openai",
      apiKey: "key456",
    });
    const providerId = result.providerId!;
    const provider = result.config.models?.providers?.[providerId];

    expect(provider?.baseUrl).toBe("https://my-resource.openai.azure.com/openai/v1");
  });

  it("re-onboard updates existing Azure provider instead of creating a duplicate", () => {
    const oldProviderId = "custom-my-resource-openai-azure-com";
    const result = applyCustomApiConfig({
      config: {
        models: {
          providers: {
            [oldProviderId]: {
              baseUrl: "https://my-resource.openai.azure.com/openai/deployments/gpt-4",
              api: "openai-completions",
              models: [
                {
                  id: "gpt-4",
                  name: "gpt-4",
                  contextWindow: 1,
                  maxTokens: 1,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  reasoning: false,
                },
              ],
            },
          },
        },
      },
      baseUrl: "https://my-resource.openai.azure.com",
      modelId: "gpt-4",
      compatibility: "openai",
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
    const result = applyCustomApiConfig({
      config: {
        models: {
          providers: {
            custom: {
              baseUrl: "http://old.example.com/v1",
              api: "openai-completions",
              models: [
                {
                  id: "old-model",
                  name: "Old",
                  contextWindow: 1,
                  maxTokens: 1,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  reasoning: false,
                },
              ],
            },
          },
        },
      },
      baseUrl: "http://localhost:11434/v1",
      modelId: "llama3",
      compatibility: "openai",
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
    const result = applyCustomApiConfig({
      config: buildCustomProviderConfig(CONTEXT_WINDOW_HARD_MIN_TOKENS),
      baseUrl: "https://llm.example.com/v1",
      modelId: "foo-large",
      compatibility: "openai",
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
    const result = applyCustomApiConfig({
      config: {
        agents: {
          defaults: {
            models: {
              [modelRef]: { params: { thinking: "high" } },
            },
          },
        },
      } as OpenClawConfig,
      baseUrl: "https://my-resource.openai.azure.com",
      modelId: "o3-mini",
      compatibility: "openai",
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

  it("parses custom image input opt-in", () => {
    const result = parseNonInteractiveCustomApiFlags({
      baseUrl: "https://llm.example.com/v1",
      modelId: "foo-large",
      supportsImageInput: true,
    });

    expect(result.supportsImageInput).toBe(true);
  });

  it("parses OpenAI Responses compatibility", () => {
    const result = parseNonInteractiveCustomApiFlags({
      baseUrl: "https://llm.example.com/v1",
      modelId: "gpt-5.4",
      compatibility: "openai-responses",
    });

    expect(result.compatibility).toBe("openai-responses");
  });

  it.each([
    {
      name: "invalid compatibility values",
      flags: {
        baseUrl: "https://llm.example.com/v1",
        modelId: "foo-large",
        compatibility: "xmlrpc",
      },
      expectedMessage:
        'Invalid --custom-compatibility (use "openai", "openai-responses", or "anthropic").',
    },
  ])("rejects $name", ({ flags, expectedMessage }) => {
    expect(() => parseNonInteractiveCustomApiFlags(flags)).toThrow(expectedMessage);
  });
});
