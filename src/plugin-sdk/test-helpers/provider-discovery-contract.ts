// Provider discovery contract helpers define reusable discovery tests for provider plugins.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runProviderCatalog } from "../../plugins/provider-discovery.js";
import {
  registerProviderPlugins as registerProviders,
  requireRegisteredProvider as requireProvider,
} from "../../test-utils/plugin-registration.js";
import type { AuthProfileStore, OpenClawConfig } from "../provider-auth.js";

const resolveCopilotRuntimeAuthMock = vi.hoisted(() => vi.fn());
const discoverLocalModelsMock = vi.hoisted(() => vi.fn());
const ensureAuthProfileStoreMock = vi.hoisted(() => vi.fn());
const listProfilesForProviderMock = vi.hoisted(() => vi.fn());

export type ProviderDiscoveryContractPluginLoader = () => Promise<{
  default: Parameters<typeof registerProviders>[0];
}>;

type ProviderHandle = Awaited<ReturnType<typeof registerProviders>>[number];

type DiscoveryContractOptions = {
  load: ProviderDiscoveryContractPluginLoader;
  providerIds: readonly string[];
  githubCopilotRegisterRuntimeModuleId?: string;
};

function setRuntimeAuthStore(store?: AuthProfileStore) {
  ensureAuthProfileStoreMock.mockReturnValue(store ?? { version: 1, profiles: {} });
  listProfilesForProviderMock.mockImplementation(
    (authStore: AuthProfileStore, providerId: string) =>
      Object.entries(authStore.profiles)
        .filter(([, credential]) => credential.provider === providerId)
        .map(([profileId]) => profileId),
  );
}

function setProfile(profileId: string, credential: AuthProfileStore["profiles"][string]) {
  setRuntimeAuthStore({ version: 1, profiles: { [profileId]: credential } });
}

function installCatalogFetch(ids: string[]) {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: ids.map((id) => ({ id })) })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());
}

function providerConfig(
  id: string,
  config: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string],
): OpenClawConfig {
  return { models: { providers: { [id]: config } } };
}

type ProviderCatalogParams = Parameters<typeof runProviderCatalog>[0];

function runCatalog(
  params: Pick<ProviderCatalogParams, "provider"> &
    Partial<
      Pick<
        ProviderCatalogParams,
        "config" | "env" | "resolveProviderApiKey" | "resolveProviderAuth"
      >
    >,
) {
  return runProviderCatalog({
    provider: params.provider,
    config: params.config ?? {},
    env: params.env ?? ({} as NodeJS.ProcessEnv),
    resolveProviderApiKey: params.resolveProviderApiKey ?? (() => ({ apiKey: undefined })),
    resolveProviderAuth:
      params.resolveProviderAuth ??
      ((_, options) => ({
        apiKey: options?.oauthMarker,
        discoveryApiKey: undefined,
        mode: options?.oauthMarker ? "oauth" : "none",
        source: options?.oauthMarker ? "profile" : "none",
      })),
  });
}

function apiKeyResolvers(apiKey: string) {
  return {
    resolveProviderApiKey: () => ({ apiKey }),
    resolveProviderAuth: () => ({
      apiKey,
      discoveryApiKey: undefined,
      mode: "api_key" as const,
      source: "env" as const,
    }),
  };
}
const noAuth = () => ({
  apiKey: undefined,
  discoveryApiKey: undefined,
  mode: "none" as const,
  source: "none" as const,
});

function runSelfHostedCatalog(provider: ProviderHandle, config: OpenClawConfig = {}) {
  const envName = provider.id === "vllm" ? "VLLM_API_KEY" : "SGLANG_API_KEY";
  const key = provider.id === "vllm" ? "env-vllm-key" : "env-sglang-key";
  const credential = { apiKey: envName, discoveryApiKey: key };
  return runCatalog({
    provider,
    config,
    env: { [envName]: key },
    resolveProviderApiKey: () => credential,
    resolveProviderAuth: () => ({ ...credential, mode: "api_key", source: "env" }),
  });
}

async function expectSelfHostedCatalog(
  provider: ProviderHandle,
  models: Array<{ id: string; name: string }>,
  baseUrl: string,
  config: OpenClawConfig = {},
) {
  discoverLocalModelsMock.mockResolvedValueOnce(structuredClone(models));
  await expect(runSelfHostedCatalog(provider, config)).resolves.toEqual({
    provider: {
      baseUrl,
      api: "openai-completions",
      apiKey: provider.id.toUpperCase() + "_API_KEY",
      models,
    },
  });
  expect(discoverLocalModelsMock).toHaveBeenCalledWith({
    apiKey: provider.id === "vllm" ? "env-vllm-key" : "env-sglang-key",
    baseUrl,
    label: provider.id === "vllm" ? "vLLM" : "SGLang",
    discoverRuntimeContext: false,
  });
}

function selfHostedConfig(providerId: string, model: string, baseUrl: string): OpenClawConfig {
  return {
    ...providerConfig(providerId, {
      baseUrl,
      apiKey: providerId.toUpperCase() + "_API_KEY",
      api: "openai-completions",
      models: [],
    }),
    agents: { defaults: { models: { [model]: {} } } },
  };
}

function expectCatalog(
  params: Parameters<typeof runCatalog>[0],
  fields: Record<string, unknown>,
  modelIds: string[] = [],
) {
  return expect(runCatalog(params)).resolves.toMatchObject({
    provider: {
      ...fields,
      models: expect.arrayContaining(modelIds.map((id) => expect.objectContaining({ id }))),
    },
  });
}

function installDiscoveryHooks(options: DiscoveryContractOptions) {
  const providers = new Map<string, ProviderHandle>();
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../provider-auth.js")>();
      return {
        ...actual,
        DEFAULT_COPILOT_API_BASE_URL: "https://api.individual.githubcopilot.com",
        MINIMAX_OAUTH_MARKER: "minimax-oauth",
        buildCopilotIdeHeaders: vi.fn(() => ({
          "Editor-Version": "vscode/1.96.2",
          "User-Agent": "GitHubCopilotChat/0.26.7",
        })),
        coerceSecretRef: asNullableRecord,
        ensureAuthProfileStore: ensureAuthProfileStoreMock,
        ensureAuthProfileStoreAsync: async (...args: unknown[]) =>
          ensureAuthProfileStoreMock(...args),
        listProfilesForProvider: listProfilesForProviderMock,
        normalizeGithubCopilotDomain: (raw: unknown) => {
          const trimmed = typeof raw === "string" ? raw.trim().toLowerCase() : "";
          return trimmed === "github.com" || /^[a-z0-9-]+\.ghe\.com$/.test(trimmed)
            ? trimmed
            : "github.com";
        },
        normalizeOptionalSecretInput: normalizeOptionalString,
        resolveNonEnvSecretRefApiKeyMarker: (source: unknown) =>
          typeof source === "string" ? source : "",
      };
    });
    vi.doMock("../../plugins/provider-self-hosted-discovery.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../plugins/provider-self-hosted-discovery.js")>();
      return {
        ...actual,
        discoverOpenAICompatibleLocalModels: discoverLocalModelsMock,
      };
    });
    if (options.githubCopilotRegisterRuntimeModuleId) {
      vi.doMock(options.githubCopilotRegisterRuntimeModuleId, async () => {
        const actual = await vi.importActual<object>(options.githubCopilotRegisterRuntimeModuleId!);
        return {
          ...actual,
          resolveCopilotRuntimeAuth: resolveCopilotRuntimeAuthMock,
        };
      });
    }
    const { default: plugin } = await options.load();
    const registeredProviders = await registerProviders(plugin);
    for (const providerId of options.providerIds) {
      providers.set(providerId, requireProvider(registeredProviders, providerId));
    }
  });

  beforeEach(() => {
    setRuntimeAuthStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resolveCopilotRuntimeAuthMock.mockReset();
    discoverLocalModelsMock.mockReset();
    ensureAuthProfileStoreMock.mockReset();
    listProfilesForProviderMock.mockReset();
    setRuntimeAuthStore();
  });

  return (providerId: string) => providers.get(providerId)!;
}

export function describeGithubCopilotProviderDiscoveryContract(params: {
  load: ProviderDiscoveryContractPluginLoader;
  registerRuntimeModuleId: string;
}) {
  describe("github-copilot provider discovery contract", () => {
    const getProvider = installDiscoveryHooks({
      providerIds: ["github-copilot"],
      load: params.load,
      githubCopilotRegisterRuntimeModuleId: params.registerRuntimeModuleId,
    });

    it("keeps catalog disabled without env tokens or profiles", async () => {
      await expect(runCatalog({ provider: getProvider("github-copilot") })).resolves.toBeNull();
    });

    it("reports an unavailable profile catalog without replacing inventory", async () => {
      setProfile("github-copilot:github", {
        type: "token",
        provider: "github-copilot",
        token: "profile-token",
      });

      await expect(runCatalog({ provider: getProvider("github-copilot") })).resolves.toEqual({
        providers: {},
        outcomes: [
          { provider: "github-copilot", profileId: "github-copilot:github", status: "unavailable" },
        ],
      });
    });

    it("keeps env-token base URL resolution provider-owned", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [] }));
      resolveCopilotRuntimeAuthMock.mockResolvedValueOnce({
        apiKey: "copilot-api-token",
        source: "validated:https://api.github.com/copilot_internal/user",
        baseUrl: "https://copilot-proxy.example.com",
      });

      await expect(
        runCatalog({
          provider: getProvider("github-copilot"),
          env: { COPILOT_GITHUB_TOKEN: "github-env-token" },
        }),
      ).resolves.toEqual({
        provider: {
          baseUrl: "https://copilot-proxy.example.com",
          models: [],
        },
        outcomes: [{ provider: "github-copilot", status: "ready" }],
      });
      expect(resolveCopilotRuntimeAuthMock.mock.calls.at(0)?.[0]).toMatchObject({
        githubToken: "github-env-token",
        env: { COPILOT_GITHUB_TOKEN: "github-env-token" },
      });
    });
  });
}

// Keep provider construction/defaults real; only model discovery is mocked.
function describeSelfHostedDiscoveryContract(
  params: { load: ProviderDiscoveryContractPluginLoader },
  id: "vllm" | "sglang",
  defaultUrl: string,
) {
  describe(`${id} provider discovery contract`, () => {
    const getProvider = installDiscoveryHooks({ ...params, providerIds: [id] });
    const routerUrl = `http://${id}-router.example/v1`;
    const models = [{ id: "contract-model", name: "Contract Model" }];

    it("keeps self-hosted discovery provider-owned", async () => {
      await expectSelfHostedCatalog(getProvider(id), models, defaultUrl);
    });

    it("uses configured transport only for provider wildcard discovery", async () => {
      await expectSelfHostedCatalog(
        getProvider(id),
        models,
        routerUrl,
        selfHostedConfig(id, `${id}/*`, routerUrl),
      );
    });

    if (id === "vllm") {
      it("uses the provider default transport when wildcard config omits baseUrl", async () => {
        await expectSelfHostedCatalog(getProvider("vllm"), models, defaultUrl, {
          agents: { defaults: { models: { "vllm/*": {} } } },
          models: {
            providers: {
              vllm: { apiKey: "VLLM_API_KEY", api: "openai-completions", models: [] },
            },
          },
        } as unknown as OpenClawConfig);
      });
    }

    it("keeps explicit self-hosted provider config manual without wildcard visibility", async () => {
      await expect(
        runSelfHostedCatalog(
          getProvider(id),
          selfHostedConfig(id, `${id}/manual-model`, routerUrl),
        ),
      ).resolves.toBeNull();
      expect(discoverLocalModelsMock).not.toHaveBeenCalled();
    });
  });
}

export function describeVllmProviderDiscoveryContract(params: {
  load: ProviderDiscoveryContractPluginLoader;
}) {
  describeSelfHostedDiscoveryContract(params, "vllm", "http://127.0.0.1:8000/v1");
}

export function describeSglangProviderDiscoveryContract(params: {
  load: ProviderDiscoveryContractPluginLoader;
}) {
  describeSelfHostedDiscoveryContract(params, "sglang", "http://127.0.0.1:30000/v1");
}

export function describeMinimaxProviderDiscoveryContract(
  load: ProviderDiscoveryContractPluginLoader,
) {
  describe("minimax provider discovery contract", () => {
    const getProvider = installDiscoveryHooks({ providerIds: ["minimax", "minimax-portal"], load });
    installCatalogFetch(["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"]);

    it("keeps API catalog provider-owned", async () => {
      await expectCatalog(
        {
          provider: getProvider("minimax"),
          env: { MINIMAX_API_KEY: "minimax-key" },
          ...apiKeyResolvers("minimax-key"),
        },
        {
          baseUrl: "https://api.minimax.io/anthropic",
          api: "anthropic-messages",
          authHeader: true,
          apiKey: "minimax-key",
        },
        ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
      );
    });

    it("keeps portal oauth marker fallback provider-owned", async () => {
      setProfile("minimax-portal:default", {
        type: "oauth",
        provider: "minimax-portal",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      });

      await expectCatalog(
        {
          provider: getProvider("minimax-portal"),
          resolveProviderAuth: () => ({
            apiKey: "minimax-oauth",
            discoveryApiKey: "access-token",
            mode: "oauth",
            source: "profile",
            profileId: "minimax-portal:default",
          }),
        },
        {
          baseUrl: "https://api.minimax.io/anthropic",
          api: "anthropic-messages",
          authHeader: true,
          apiKey: "minimax-oauth",
        },
        ["MiniMax-M2.7"],
      );
    });

    it("keeps portal explicit base URL override provider-owned", async () => {
      await expectCatalog(
        {
          provider: getProvider("minimax-portal"),
          config: providerConfig("minimax-portal", {
            baseUrl: "https://portal-proxy.example.com/anthropic",
            apiKey: "explicit-key",
            models: [],
          }),
          resolveProviderAuth: noAuth,
        },
        {
          baseUrl: "https://portal-proxy.example.com/anthropic",
          apiKey: "explicit-key",
        },
      );
    });
  });
}

export function describeModelStudioProviderDiscoveryContract(
  load: ProviderDiscoveryContractPluginLoader,
) {
  describe("modelstudio provider discovery contract", () => {
    const getProvider = installDiscoveryHooks({ providerIds: ["qwen"], load });
    installCatalogFetch(["qwen3.5-plus", "qwen3-max-2026-01-23", "MiniMax-M2.5"]);

    it("keeps catalog provider-owned", async () => {
      await expectCatalog(
        {
          provider: getProvider("qwen"),
          config: providerConfig("modelstudio", {
            baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
            models: [],
          }),
          env: { MODELSTUDIO_API_KEY: "modelstudio-key" },
          ...apiKeyResolvers("modelstudio-key"),
        },
        {
          baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
          api: "openai-completions",
          apiKey: "modelstudio-key",
        },
        ["qwen3.5-plus", "qwen3-max-2026-01-23", "MiniMax-M2.5"],
      );
    });
  });
}

export function describeCloudflareAiGatewayProviderDiscoveryContract(
  load: ProviderDiscoveryContractPluginLoader,
) {
  describe("cloudflare-ai-gateway provider discovery contract", () => {
    const getProvider = installDiscoveryHooks({
      providerIds: ["cloudflare-ai-gateway"],
      load,
    });

    it("keeps catalog disabled without stored metadata", async () => {
      await expect(
        runCatalog({
          provider: getProvider("cloudflare-ai-gateway"),
          resolveProviderAuth: noAuth,
        }),
      ).resolves.toBeNull();
    });

    it("keeps env-managed catalog provider-owned", async () => {
      setProfile("cloudflare-ai-gateway:default", {
        type: "api_key",
        provider: "cloudflare-ai-gateway",
        keyRef: {
          source: "env",
          provider: "default",
          id: "CLOUDFLARE_AI_GATEWAY_API_KEY",
        },
        metadata: { accountId: "acc-123", gatewayId: "gw-456" },
      });

      await expect(
        runCatalog({
          provider: getProvider("cloudflare-ai-gateway"),
          env: { CLOUDFLARE_AI_GATEWAY_API_KEY: "secret-value" },
          resolveProviderAuth: noAuth,
        }),
      ).resolves.toMatchObject({
        provider: {
          baseUrl: "https://gateway.ai.cloudflare.com/v1/acc-123/gw-456/anthropic",
          api: "anthropic-messages",
          apiKey: "CLOUDFLARE_AI_GATEWAY_API_KEY",
          models: [{ id: "claude-sonnet-4-6" }],
        },
      });
    });
  });
}
