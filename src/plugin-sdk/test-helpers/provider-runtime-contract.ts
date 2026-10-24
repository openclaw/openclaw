// Provider runtime contract helpers define reusable runtime tests for provider plugins.
import { normalizeModelCatalog } from "@openclaw/model-catalog-core/model-catalog-normalize";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../../config/plugin-auto-enable.test-helpers.js";
import type { ProviderRuntimeModel } from "../plugin-entry.js";
import { registerProviderPlugin, requireRegisteredProvider } from "../plugin-test-runtime.js";
import { buildManifestModelProviderConfig } from "../provider-catalog-shared.js";
import type { ProviderPlugin } from "../provider-model-shared.js";
import { createProviderUsageFetch, makeResponse } from "../test-env.js";

const CONTRACT_SETUP_TIMEOUT_MS = 300_000;

const OPENAI_CODEX_PROVIDER_RUNTIME_MODULE_ID =
  "../../../extensions/openai/openai-chatgpt-provider.runtime.js";
const refreshOpenAICodexTokenMock = vi.fn();

function installProviderRuntimeContractMocks() {
  vi.doMock(OPENAI_CODEX_PROVIDER_RUNTIME_MODULE_ID, () => ({
    refreshOpenAICodexToken: refreshOpenAICodexTokenMock,
  }));
}

function removeProviderRuntimeContractMocks() {
  vi.doUnmock(OPENAI_CODEX_PROVIDER_RUNTIME_MODULE_ID);
}

function createModel(overrides: Partial<ProviderRuntimeModel> & Pick<ProviderRuntimeModel, "id">) {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    api: overrides.api ?? "openai-responses",
    provider: overrides.provider ?? "demo",
    baseUrl: overrides.baseUrl ?? "https://api.example.com/v1",
    reasoning: overrides.reasoning ?? true,
    input: overrides.input ?? ["text"],
    cost: overrides.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: overrides.contextWindow ?? 200_000,
    maxTokens: overrides.maxTokens ?? 8_192,
  } satisfies ProviderRuntimeModel;
}

function createManifestModelFactory(providerId: string, catalog: unknown) {
  const provider = buildManifestModelProviderConfig({ providerId, catalog });
  return (modelId: string, overrides: Partial<ProviderRuntimeModel> = {}): ProviderRuntimeModel => {
    const model = provider.models.find((candidate) => candidate.id === modelId);
    if (!model) {
      throw new Error(`Missing ${providerId} manifest model ${modelId}`);
    }
    const input = model.input.filter(
      (item): item is "text" | "image" => item === "text" || item === "image",
    );
    if (input.length !== model.input.length) {
      throw new Error(`Unsupported ${providerId} manifest model input for ${modelId}`);
    }
    return createModel({
      ...model,
      id: model.id,
      provider: providerId,
      baseUrl: model.baseUrl ?? provider.baseUrl,
      api: model.api ?? provider.api,
      input,
      ...overrides,
    });
  };
}

function expectFields(value: unknown, fields: Record<string, unknown>) {
  expect(value, "record").toBeTypeOf("object");
  expect(value, "record").not.toBeNull();
  expect(value).toEqual(expect.objectContaining(fields));
}

export type ProviderRuntimeContractPluginLoader = () => Promise<{
  default: Parameters<typeof registerProviderPlugin>[0]["plugin"];
}>;

function installRuntimeHooks(
  load: ProviderRuntimeContractPluginLoader,
  pluginId: string,
  name: string,
  providerIds = [pluginId],
) {
  const providers = new Map<string, ProviderPlugin>();
  beforeAll(async () => {
    installProviderRuntimeContractMocks();
    const plugin = await load();
    const registered = await registerProviderPlugin({
      plugin: plugin.default,
      id: pluginId,
      name,
    });
    for (const id of providerIds) {
      providers.set(id, requireRegisteredProvider(registered.providers, id, "provider"));
    }
  }, CONTRACT_SETUP_TIMEOUT_MS);
  afterAll(removeProviderRuntimeContractMocks);
  beforeEach(() => {
    refreshOpenAICodexTokenMock.mockReset();
  }, CONTRACT_SETUP_TIMEOUT_MS);
  return (providerId: string) => expectDefined(providers.get(providerId), providerId);
}

function fetchUsageSnapshot(
  provider: ProviderPlugin,
  token: string,
  path: string,
  body: unknown,
  accountId?: string,
) {
  const mockFetch = createProviderUsageFetch(async (url) =>
    url.includes(path) ? makeResponse(200, body) : makeResponse(404, "not found"),
  );
  return provider.fetchUsageSnapshot?.({
    config: {},
    env: {},
    provider: provider.id,
    token,
    accountId,
    timeoutMs: 5_000,
    fetchFn: mockFetch as unknown as typeof fetch,
  });
}

type DynamicContext = Parameters<NonNullable<ProviderPlugin["resolveDynamicModel"]>>[0];
function resolveFromTemplate(
  provider: ProviderPlugin,
  modelId: string,
  template: ProviderRuntimeModel | null,
  options: Partial<Omit<DynamicContext, "provider" | "modelId" | "modelRegistry">> = {},
) {
  return provider.resolveDynamicModel?.({
    provider: provider.id,
    modelId,
    modelRegistry: {
      find: (_provider: string, id: string) => (id === template?.id ? template : null),
    } as never,
    ...options,
  });
}

export function describeAnthropicProviderRuntimeContract(
  load: ProviderRuntimeContractPluginLoader,
) {
  describe("anthropic provider runtime contract", { timeout: CONTRACT_SETUP_TIMEOUT_MS }, () => {
    const getProvider = installRuntimeHooks(load, "anthropic", "Anthropic");

    it("owns anthropic 4.6 forward-compat resolution", () => {
      const provider = getProvider("anthropic");
      // The dated 4.6 template has no owning manifest row; keep its remap fixture literal.
      const model = resolveFromTemplate(
        provider,
        "claude-sonnet-4.6-20260219",
        createModel({
          id: "claude-sonnet-4-6-20260219",
          api: "anthropic-messages",
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com",
        }),
      );

      expectFields(model, {
        id: "claude-sonnet-4.6-20260219",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      });
    });

    it("owns usage auth resolution", async () => {
      const provider = getProvider("anthropic");
      await expect(
        provider.resolveUsageAuth?.({
          config: {} as never,
          env: {} as NodeJS.ProcessEnv,
          provider: "anthropic",
          resolveApiKeyFromConfigAndStore: () => undefined,
          resolveOAuthToken: async () => ({
            token: "anthropic-oauth-token",
          }),
        }),
      ).resolves.toEqual({
        token: "anthropic-oauth-token",
      });
    });

    it("owns auth doctor hint generation", async () => {
      const provider = getProvider("anthropic");
      const hint = await provider.buildAuthDoctorHint?.({
        provider: "anthropic",
        profileId: "anthropic:default",
        config: {
          auth: {
            profiles: {
              "anthropic:default": {
                provider: "anthropic",
                mode: "oauth",
              },
            },
          },
        } as never,
        store: {
          version: 1,
          profiles: {
            "anthropic:oauth-user@example.com": {
              type: "oauth",
              provider: "anthropic",
              access: "oauth-access",
              refresh: "oauth-refresh",
              expires: Date.now() + 60_000,
            },
          },
        },
      });

      expect(hint).toContain("suggested profile: anthropic:oauth-user@example.com");
      expect(hint).toContain("openclaw doctor --yes");
    });

    it("owns usage snapshot fetching", async () => {
      const provider = getProvider("anthropic");
      await expect(
        fetchUsageSnapshot(provider, "anthropic-oauth-token", "api.anthropic.com/api/oauth/usage", {
          five_hour: { utilization: 20, resets_at: "2026-01-07T01:00:00Z" },
          seven_day: { utilization: 35, resets_at: "2026-01-09T01:00:00Z" },
        }),
      ).resolves.toEqual({
        provider: "anthropic",
        displayName: "Claude",
        windows: [
          { label: "5h", usedPercent: 20, resetAt: Date.parse("2026-01-07T01:00:00Z") },
          { label: "Week", usedPercent: 35, resetAt: Date.parse("2026-01-09T01:00:00Z") },
        ],
      });
    });
  });
}

export function describeGithubCopilotProviderRuntimeContract(
  load: ProviderRuntimeContractPluginLoader,
  manifestCatalog: unknown,
) {
  describe(
    "github-copilot provider runtime contract",
    { timeout: CONTRACT_SETUP_TIMEOUT_MS },
    () => {
      const getProvider = installRuntimeHooks(load, "github-copilot", "GitHub Copilot");
      const createManifestModel = createManifestModelFactory("github-copilot", manifestCatalog);

      async function resolveStaticModel(modelId: string) {
        const { createBundledStaticCatalogModelResolver } =
          await import("../../agents/embedded-agent-runner/model.static-catalog.js");
        const config = {
          models: { catalogRefresh: { enabled: false } },
        };
        const metadataSnapshot = createPluginMetadataSnapshot({
          config,
          manifestRegistry: {
            diagnostics: [],
            plugins: [
              {
                id: "github-copilot",
                origin: "bundled",
                providers: ["github-copilot"],
                channels: [],
                cliBackends: [],
                skills: [],
                hooks: [],
                rootDir: "/fixtures/github-copilot",
                source: "/fixtures/github-copilot/index.js",
                manifestPath: "/fixtures/github-copilot/openclaw.plugin.json",
                modelCatalog: normalizeModelCatalog(
                  {
                    providers: { "github-copilot": manifestCatalog },
                    discovery: { "github-copilot": "runtime" },
                  },
                  { ownedProviders: new Set(["github-copilot"]) },
                ),
              },
            ],
          },
        });
        const resolveModel = createBundledStaticCatalogModelResolver({
          cfg: config,
          env: {},
          metadataSnapshot,
          includeRuntimeDiscovery: true,
        });
        return {
          config,
          model: expectDefined(resolveModel({ provider: "github-copilot", modelId }), modelId),
        };
      }

      it.each([
        ["gemini-3.6-flash", "openai-completions"],
        ["gemini-3.1-pro-preview", "openai-completions"],
        ["gemini-3.5-flash", "openai-completions"],
        ["gemini-2.5-pro", "openai-completions"],
        ["gpt-5.6-sol", "openai-responses"],
        ["claude-sonnet-5", "anthropic-messages"],
      ] as const)("routes static %s through %s", async (modelId, api) => {
        const { config, model } = await resolveStaticModel(modelId);
        expect(model.api).toBe(api);
        if (api === "openai-completions") {
          expect(model.compat).toMatchObject({
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsUsageInStreaming: false,
            maxTokensField: "max_tokens",
          });
        }
        const provider = getProvider("github-copilot");
        expect(
          provider.preferRuntimeResolvedModel?.({
            config,
            provider: "github-copilot",
            modelId,
          }),
        ).toBe(true);
        // A missing prepared live row also occurs when enabled discovery is unavailable.
        expect(
          provider.resolveDynamicModel?.({
            config,
            provider: "github-copilot",
            modelId,
            modelRegistry: {
              find: () => model,
              getAll: () => [model],
              getAvailable: () => [],
              hasConfiguredAuth: () => false,
            },
          }),
        ).toBeUndefined();
      });

      it.each([
        ["minimal", "low"],
        ["xhigh", "xhigh"],
      ] as const)("sends static GPT-5.4 mini %s thinking as %s", async (level, effort) => {
        const { createApiRegistry, createLlmRuntime } = await import("@openclaw/ai");
        const { streamOpenAIResponses, streamSimpleOpenAIResponses } =
          await import("@openclaw/ai/internal/openai");
        const { config, model } = await resolveStaticModel("gpt-5.4-mini");
        const provider = getProvider("github-copilot");
        const profile = provider.resolveThinkingProfile?.({
          provider: model.provider,
          modelId: model.id,
          api: model.api,
          compat: model.compat,
        });
        const registry = createApiRegistry();
        registry.registerApiProvider({
          api: "openai-responses",
          stream: streamOpenAIResponses,
          streamSimple: streamSimpleOpenAIResponses,
        });
        const stream = expectDefined(
          provider.wrapStreamFn?.({
            config,
            provider: model.provider,
            modelId: model.id,
            model,
            streamFn: createLlmRuntime(registry).streamSimple,
          }),
          "Copilot stream wrapper",
        );
        const network = vi
          .spyOn(globalThis, "fetch")
          .mockRejectedValue(new Error("Unexpected network"));
        const payloads: unknown[] = [];
        try {
          const response = await stream(
            model,
            {
              messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
            },
            {
              apiKey: "test-token",
              reasoning: level,
              maxTokens: 1024,
              onPayload: (payload) => {
                payloads.push(payload);
                throw new Error("Captured payload before network");
              },
            },
          );
          await response.result();
          expect(network).not.toHaveBeenCalled();
          expect.soft(profile?.levels.map(({ id }) => id)).toContain(level);
          expect(profile?.levels.map(({ id }) => id)).not.toContain("max");
          expect(payloads).toEqual([
            expect.objectContaining({ reasoning: expect.objectContaining({ effort }) }),
          ]);
        } finally {
          network.mockRestore();
        }
      });

      it("owns Copilot-specific forward-compat fallbacks", () => {
        const provider = getProvider("github-copilot");
        const expected = createManifestModel("gpt-5.4");
        const model = resolveFromTemplate(provider, "gpt-5.4", null);

        const { baseUrl: _providerDefault, ...manifestFields } = expected;
        expectFields(model, manifestFields);
      });
    },
  );
}

export function describeGoogleProviderRuntimeContract(load: ProviderRuntimeContractPluginLoader) {
  describe("google provider runtime contract", { timeout: CONTRACT_SETUP_TIMEOUT_MS }, () => {
    const getProvider = installRuntimeHooks(load, "google", "Google", [
      "google",
      "google-gemini-cli",
    ]);

    it.each([
      ["google", "google-generative-ai", "https://generativelanguage.googleapis.com"],
      ["google-gemini-cli", "google-gemini-cli", "https://cloudcode-pa.googleapis.com"],
    ] as const)("owns %s gemini 3.1 forward-compat resolution", (providerId, api, baseUrl) => {
      // Runtime-discovered catalogs no longer contain the retired 3.0 template.
      const model = resolveFromTemplate(
        getProvider(providerId),
        "gemini-3.1-pro-preview",
        createModel({
          id: "gemini-3-pro-preview",
          provider: providerId,
          api,
          baseUrl,
          reasoning: false,
          contextWindow: 1_048_576,
          maxTokens: 65_536,
        }),
      );
      expectFields(model, {
        id: "gemini-3.1-pro-preview",
        provider: providerId,
        reasoning: true,
        ...(providerId === "google" ? { api, baseUrl } : {}),
      });
    });
  });
}

export function describeOpenAIProviderRuntimeContract(
  load: ProviderRuntimeContractPluginLoader,
  manifestCatalog: unknown,
) {
  describe("openai provider runtime contract", { timeout: CONTRACT_SETUP_TIMEOUT_MS }, () => {
    const createManifestModel = createManifestModelFactory("openai", manifestCatalog);
    const codexProviderConfig = {
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    } as const;
    const getProvider = installRuntimeHooks(load, "openai", "OpenAI");

    // Literal retired templates keep family patches independent of the current manifest.
    it.each([
      ["gpt-5.4-pro", "gpt-5.2-pro", {}, { contextWindow: 1_050_000, maxTokens: 128_000 }],
      ["gpt-5.5", "gpt-5.4", {}, createManifestModel("gpt-5.5", { name: "gpt-5.5" })],
      [
        "gpt-5.4-mini",
        "gpt-5-mini",
        { contextWindow: 400_000, maxTokens: 128_000 },
        { contextWindow: 400_000, maxTokens: 128_000 },
      ],
    ] as const)(
      "owns direct %s forward-compat resolution from %s",
      (modelId, templateId, overrides, expected) => {
        const model = resolveFromTemplate(
          getProvider("openai"),
          modelId,
          createModel({
            id: templateId,
            provider: "openai",
            baseUrl: "https://api.openai.com/v1",
            input: ["text", "image"],
            ...overrides,
          }),
        );
        expectFields(model, {
          id: modelId,
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          ...expected,
        });
      },
    );

    it("owns direct openai transport normalization", () => {
      const provider = getProvider("openai");
      // The normalized gpt-5.4 input is intentionally outside the current OpenAI manifest.
      expectFields(
        provider.normalizeResolvedModel?.({
          provider: "openai",
          modelId: "gpt-5.4",
          model: createModel({
            id: "gpt-5.4",
            provider: "openai",
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
            input: ["text", "image"],
            contextWindow: 1_050_000,
            maxTokens: 128_000,
          }),
        }),
        {
          api: "openai-responses",
        },
      );
    });

    it("propagates accountId refresh failures to the credential owner", async () => {
      const provider = getProvider("openai");
      const credential = {
        type: "oauth" as const,
        provider: "openai",
        access: "cached-access-token",
        refresh: "refresh-token",
        expires: Date.now() - 60_000,
      };

      const failure = new Error("Failed to extract accountId from token");
      refreshOpenAICodexTokenMock.mockRejectedValueOnce(failure);

      await expect(provider.refreshOAuth?.(credential)).rejects.toBe(failure);
    });

    it("uses the subscription budget with a manifest-backed startup registry", async () => {
      const [{ ModelRegistry }, { AuthStorage }] = await Promise.all([
        import("../../agents/sessions/model-registry.js"),
        import("../../agents/sessions/auth-storage.js"),
      ]);
      const registry = ModelRegistry.create(AuthStorage.inMemory(), undefined, {
        modelsJsonContents: null,
        pluginCatalogs: [],
        staticProviderConfigs: {
          openai: buildManifestModelProviderConfig({
            providerId: "openai",
            catalog: manifestCatalog,
          }),
        },
      });
      // Startup publishes the shared Platform manifest before account discovery.
      expect(registry.find("openai", "gpt-6.1-sol")).toMatchObject({
        api: "openai-responses",
        contextTokens: 272_000,
      });
      const provider = getProvider("openai");
      const selection = {
        provider: "openai",
        modelId: "gpt-6.1-sol",
        agentRuntimeId: "openclaw",
        modelRegistry: registry,
      };
      const model = provider.resolveDynamicModel?.({
        ...selection,
        authProfileMode: "oauth",
        providerConfig: codexProviderConfig,
      });
      expect(model).toMatchObject({
        api: "openai-chatgpt-responses",
        contextTokens: 500_000,
      });
      expect(
        provider.resolveDynamicModel?.({
          ...selection,
          authProfileMode: "api_key",
        }),
      ).toMatchObject({ api: "openai-responses", contextTokens: 272_000 });
    });

    it("keeps OpenClaw cost metadata but applies Codex context metadata for gpt-5.5 models", () => {
      const provider = getProvider("openai");
      const manifestModel = createManifestModel("gpt-5.5", {
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        contextWindow: 272_000,
      });
      const model = resolveFromTemplate(provider, "gpt-5.5", manifestModel, {
        authProfileMode: "oauth",
        providerConfig: codexProviderConfig,
      });

      expectFields(model, {
        ...manifestModel,
        api: "openai-chatgpt-responses",
        baseUrl: codexProviderConfig.baseUrl,
        contextWindow: 400_000,
      });
    });

    it("owns codex transport defaults", () => {
      const provider = getProvider("openai");
      expect(
        provider.prepareExtraParams?.({
          provider: "openai",
          modelId: "gpt-5.4",
          model: createModel({
            id: "gpt-5.4",
            provider: "openai",
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
          }),
          extraParams: { temperature: 0.2 },
        }),
      ).toEqual({
        temperature: 0.2,
        transport: "auto",
      });
    });

    it("owns usage snapshot fetching", async () => {
      const provider = getProvider("openai");
      await expect(
        fetchUsageSnapshot(
          provider,
          "codex-token",
          "chatgpt.com/backend-api/wham/usage",
          {
            rate_limit: {
              primary_window: {
                used_percent: 12,
                limit_window_seconds: 10800,
                reset_at: 1_705_000,
              },
            },
            plan_type: "Plus",
          },
          "acc-1",
        ),
      ).resolves.toEqual({
        provider: "openai",
        displayName: "OpenAI",
        windows: [{ label: "3h", usedPercent: 12, resetAt: 1_705_000_000 }],
        plan: "Plus",
      });
    });
  });
}

export function describeOpenRouterProviderRuntimeContract(
  load: ProviderRuntimeContractPluginLoader,
) {
  describe("openrouter provider runtime contract", { timeout: CONTRACT_SETUP_TIMEOUT_MS }, () => {
    const getProvider = installRuntimeHooks(load, "openrouter", "OpenRouter");

    it("owns dynamic OpenRouter model defaults", () => {
      const provider = getProvider("openrouter");
      // OpenRouter owns a runtime-discovered catalog, so these synthetic defaults stay literal.
      const model = resolveFromTemplate(provider, "x-ai/grok-4-1-fast", null);

      expectFields(model, {
        id: "x-ai/grok-4-1-fast",
        provider: "openrouter",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
        maxTokens: 8192,
      });
    });
  });
}

export function describeZAIProviderRuntimeContract(load: ProviderRuntimeContractPluginLoader) {
  describe("zai provider runtime contract", { timeout: CONTRACT_SETUP_TIMEOUT_MS }, () => {
    const getProvider = installRuntimeHooks(load, "zai", "Z.AI");

    it("owns glm-5 forward-compat resolution", () => {
      const provider = getProvider("zai");
      // Neither the synthetic glm-5 id nor its glm-4.7 template has a current manifest row.
      const model = resolveFromTemplate(
        provider,
        "glm-5",
        createModel({
          id: "glm-4.7",
          api: "openai-completions",
          provider: "zai",
          baseUrl: "https://api.z.ai/api/paas/v4",
          reasoning: false,
          contextWindow: 202_752,
          maxTokens: 16_384,
        }),
      );

      expectFields(model, {
        id: "glm-5",
        provider: "zai",
        api: "openai-completions",
        reasoning: true,
      });
    });

    it("owns Z.AI token-limit overflow classification", () => {
      const provider = getProvider("zai");

      expect(
        provider.matchesContextOverflowError?.({
          errorMessage: "code 1210: tokens in request more than max tokens allowed",
        }),
      ).toBe(true);
      expect(
        provider.matchesContextOverflowError?.({
          errorMessage: "code 1261: Prompt exceeds max length",
        }),
      ).toBe(true);
      expect(
        provider.matchesContextOverflowError?.({
          errorMessage: "code 1210: invalid request parameters",
        }),
      ).toBe(false);
    });

    it("owns usage auth resolution", async () => {
      const provider = getProvider("zai");
      await expect(
        provider.resolveUsageAuth?.({
          config: {} as never,
          env: {
            ZAI_API_KEY: "env-zai-token",
          } as NodeJS.ProcessEnv,
          provider: "zai",
          resolveApiKeyFromConfigAndStore: () => undefined,
          resolveApiKeyCandidatesFromConfigAndStore: async () => ["env-zai-token"],
          resolveOAuthToken: async () => null,
        }),
      ).resolves.toEqual({
        token: "env-zai-token",
      });
    });

    it("owns usage snapshot fetching", async () => {
      const provider = getProvider("zai");
      await expect(
        fetchUsageSnapshot(provider, "env-zai-token", "api.z.ai/api/monitor/usage/quota/limit", {
          success: true,
          code: 200,
          data: {
            planName: "Pro",
            limits: [
              {
                type: "TOKENS_LIMIT",
                percentage: 25,
                unit: 3,
                number: 6,
                nextResetTime: "2026-01-07T06:00:00Z",
              },
            ],
          },
        }),
      ).resolves.toEqual({
        provider: "zai",
        displayName: "z.ai",
        windows: [{ label: "Tokens (6h)", usedPercent: 25, resetAt: 1_767_765_600_000 }],
        plan: "Pro",
      });
    });
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
