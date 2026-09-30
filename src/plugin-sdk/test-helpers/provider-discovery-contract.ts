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
const buildVllmProviderMock = vi.hoisted(() => vi.fn());
const buildSglangProviderMock = vi.hoisted(() => vi.fn());
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
  vllmApiModuleId?: string;
  sglangApiModuleId?: string;
};

function setRuntimeAuthStore(store?: AuthProfileStore) {
  const resolvedStore = store ?? {
    version: 1,
    profiles: {},
  };
  ensureAuthProfileStoreMock.mockReturnValue(resolvedStore);
  listProfilesForProviderMock.mockImplementation(
    (authStore: AuthProfileStore, providerId: string) =>
      Object.entries(authStore.profiles)
        .filter(([, credential]) => credential.provider === providerId)
        .map(([profileId]) => profileId),
  );
}

function setGithubCopilotProfileSnapshot() {
  setRuntimeAuthStore({
    version: 1,
    profiles: {
      "github-copilot:github": {
        type: "token",
        provider: "github-copilot",
        token: "profile-token",
      },
    },
  });
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeTypeOf("object");
  expect(value, label).not.toBeNull();
  return value as Record<string, unknown>;
}

function expectProviderFields(result: unknown, fields: Record<string, unknown>) {
  const provider = requireRecord(requireRecord(result, "catalog result").provider, "provider");
  for (const [key, expected] of Object.entries(fields)) {
    expect(provider[key]).toEqual(expected);
  }
  return provider;
}

function providerModelIds(provider: Record<string, unknown>): Array<unknown> {
  const models = provider.models;
  expect(Array.isArray(models), "provider models").toBe(true);
  return (models as Array<{ id?: unknown }>).map((model) => model.id);
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
        applyAuthProfileConfig: (config: OpenClawConfig) => config,
        buildApiKeyCredential: (
          provider: string,
          key: unknown,
          metadata?: Record<string, unknown>,
        ) => ({
          type: "api_key",
          provider,
          ...(typeof key === "string" ? { key } : {}),
          ...(metadata ? { metadata } : {}),
        }),
        buildOauthProviderAuthResult: vi.fn(),
        buildCopilotIdeHeaders: vi.fn(() => ({
          "Editor-Version": "vscode/1.96.2",
          "User-Agent": "GitHubCopilotChat/0.26.7",
        })),
        coerceSecretRef: asNullableRecord,
        ensureApiKeyFromOptionEnvOrPrompt: vi.fn(),
        ensureAuthProfileStore: ensureAuthProfileStoreMock,
        listProfilesForProvider: listProfilesForProviderMock,
        normalizeApiKeyInput: (value: unknown) => (typeof value === "string" ? value.trim() : ""),
        normalizeGithubCopilotDomain: (raw: unknown) => {
          const trimmed = typeof raw === "string" ? raw.trim().toLowerCase() : "";
          return trimmed === "github.com" || /^[a-z0-9-]+\.ghe\.com$/.test(trimmed)
            ? trimmed
            : "github.com";
        },
        normalizeOptionalSecretInput: normalizeOptionalString,
        resolveNonEnvSecretRefApiKeyMarker: (source: unknown) =>
          typeof source === "string" ? source : "",
        upsertAuthProfile: vi.fn(),
        validateApiKeyInput: () => undefined,
      };
    });
    vi.doMock("openclaw/plugin-sdk/provider-setup", async () => {
      const actual = await vi.importActual<typeof import("../provider-setup.js")>(
        "openclaw/plugin-sdk/provider-setup",
      );
      return {
        ...actual,
        discoverOpenAICompatibleLocalModels: async (params: {
          apiKey?: string;
          baseUrl: string;
          label: string;
        }) => {
          const isVllm = params.label === "vLLM";
          const defaultBaseUrl = isVllm ? "http://127.0.0.1:8000/v1" : "http://127.0.0.1:30000/v1";
          const provider = requireRecord(
            await (isVllm ? buildVllmProviderMock : buildSglangProviderMock)({
              apiKey: params.apiKey,
              ...(params.baseUrl === defaultBaseUrl ? {} : { baseUrl: params.baseUrl }),
            }),
            `${params.label} provider`,
          );
          return Array.isArray(provider.models) ? provider.models : [];
        },
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
    if (options.vllmApiModuleId) {
      vi.doMock(options.vllmApiModuleId, async () => {
        return {
          VLLM_DEFAULT_API_KEY_ENV_VAR: "VLLM_API_KEY",
          VLLM_DEFAULT_BASE_URL: "http://127.0.0.1:8000/v1",
          VLLM_MODEL_PLACEHOLDER: "meta-llama/Meta-Llama-3-8B-Instruct",
          VLLM_PROVIDER_LABEL: "vLLM",
        };
      });
    }
    if (options.sglangApiModuleId) {
      vi.doMock(options.sglangApiModuleId, async () => {
        return {
          SGLANG_DEFAULT_API_KEY_ENV_VAR: "SGLANG_API_KEY",
          SGLANG_DEFAULT_BASE_URL: "http://127.0.0.1:30000/v1",
          SGLANG_MODEL_PLACEHOLDER: "Qwen/Qwen3-8B",
          SGLANG_PROVIDER_LABEL: "SGLang",
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
    buildVllmProviderMock.mockReset();
    buildSglangProviderMock.mockReset();
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
      setGithubCopilotProfileSnapshot();

      await expect(
        runCatalog({
          provider: getProvider("github-copilot"),
        }),
      ).resolves.toEqual({
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
          env: {
            COPILOT_GITHUB_TOKEN: "github-env-token",
          } as NodeJS.ProcessEnv,
          resolveProviderApiKey: () => ({ apiKey: undefined }),
        }),
      ).resolves.toEqual({
        provider: {
          baseUrl: "https://copilot-proxy.example.com",
          models: [],
        },
        outcomes: [{ provider: "github-copilot", status: "ready" }],
      });
      const copilotCall = requireRecord(
        resolveCopilotRuntimeAuthMock.mock.calls.at(0)?.[0],
        "copilot token params",
      );
      expect(copilotCall.githubToken).toBe("github-env-token");
      const env = requireRecord(copilotCall.env, "copilot token env");
      expect(env.COPILOT_GITHUB_TOKEN).toBe("github-env-token");
    });
  });
}

export function describeVllmProviderDiscoveryContract(params: {
  load: ProviderDiscoveryContractPluginLoader;
  apiModuleId: string;
}) {
  describe("vllm provider discovery contract", () => {
    const getProvider = installDiscoveryHooks({
      providerIds: ["vllm"],
      load: params.load,
      vllmApiModuleId: params.apiModuleId,
    });

    it("keeps self-hosted discovery provider-owned", async () => {
      buildVllmProviderMock.mockResolvedValueOnce({
        baseUrl: "http://127.0.0.1:8000/v1",
        api: "openai-completions",
        models: [{ id: "meta-llama/Meta-Llama-3-8B-Instruct", name: "Meta Llama 3" }],
      });

      await expect(
        runCatalog({
          provider: getProvider("vllm"),
          config: {},
          env: {
            VLLM_API_KEY: "env-vllm-key",
          } as NodeJS.ProcessEnv,
          resolveProviderApiKey: () => ({
            apiKey: "VLLM_API_KEY",
            discoveryApiKey: "env-vllm-key",
          }),
          resolveProviderAuth: () => ({
            apiKey: "VLLM_API_KEY",
            discoveryApiKey: "env-vllm-key",
            mode: "api_key",
            source: "env",
          }),
        }),
      ).resolves.toEqual({
        provider: {
          baseUrl: "http://127.0.0.1:8000/v1",
          api: "openai-completions",
          apiKey: "VLLM_API_KEY",
          models: [{ id: "meta-llama/Meta-Llama-3-8B-Instruct", name: "Meta Llama 3" }],
        },
      });
      expect(buildVllmProviderMock).toHaveBeenCalledWith({
        apiKey: "env-vllm-key",
      });
    });

    it("uses configured transport only for provider wildcard discovery", async () => {
      buildVllmProviderMock.mockResolvedValueOnce({
        baseUrl: "http://vllm-router.example/v1",
        api: "openai-completions",
        models: [{ id: "router-model", name: "Router Model" }],
      });

      await expect(
        runCatalog({
          provider: getProvider("vllm"),
          config: {
            agents: {
              defaults: {
                models: {
                  "vllm/*": {},
                },
              },
            },
            models: {
              providers: {
                vllm: {
                  baseUrl: "http://vllm-router.example/v1",
                  apiKey: "VLLM_API_KEY",
                  api: "openai-completions",
                  models: [],
                },
              },
            },
          } as unknown as OpenClawConfig,
          env: {
            VLLM_API_KEY: "env-vllm-key",
          } as NodeJS.ProcessEnv,
          resolveProviderApiKey: () => ({
            apiKey: "VLLM_API_KEY",
            discoveryApiKey: "env-vllm-key",
          }),
          resolveProviderAuth: () => ({
            apiKey: "VLLM_API_KEY",
            discoveryApiKey: "env-vllm-key",
            mode: "api_key",
            source: "env",
          }),
        }),
      ).resolves.toEqual({
        provider: {
          baseUrl: "http://vllm-router.example/v1",
          api: "openai-completions",
          apiKey: "VLLM_API_KEY",
          models: [{ id: "router-model", name: "Router Model" }],
        },
      });
      expect(buildVllmProviderMock).toHaveBeenCalledWith({
        apiKey: "env-vllm-key",
        baseUrl: "http://vllm-router.example/v1",
      });
    });

    it("uses the provider default transport when wildcard config omits baseUrl", async () => {
      buildVllmProviderMock.mockResolvedValueOnce({
        baseUrl: "http://127.0.0.1:8000/v1",
        api: "openai-completions",
        models: [{ id: "default-transport-model", name: "Default Transport Model" }],
      });

      await expect(
        runCatalog({
          provider: getProvider("vllm"),
          config: {
            agents: {
              defaults: {
                models: {
                  "vllm/*": {},
                },
              },
            },
            models: {
              providers: {
                vllm: {
                  apiKey: "VLLM_API_KEY",
                  api: "openai-completions",
                  models: [],
                },
              },
            },
          } as unknown as OpenClawConfig,
          env: {
            VLLM_API_KEY: "env-vllm-key",
          } as NodeJS.ProcessEnv,
          resolveProviderApiKey: () => ({
            apiKey: "VLLM_API_KEY",
            discoveryApiKey: "env-vllm-key",
          }),
          resolveProviderAuth: () => ({
            apiKey: "VLLM_API_KEY",
            discoveryApiKey: "env-vllm-key",
            mode: "api_key",
            source: "env",
          }),
        }),
      ).resolves.toEqual({
        provider: {
          baseUrl: "http://127.0.0.1:8000/v1",
          api: "openai-completions",
          apiKey: "VLLM_API_KEY",
          models: [{ id: "default-transport-model", name: "Default Transport Model" }],
        },
      });
      expect(buildVllmProviderMock).toHaveBeenCalledWith({
        apiKey: "env-vllm-key",
      });
    });

    it("keeps explicit self-hosted provider config manual without wildcard visibility", async () => {
      await expect(
        runCatalog({
          provider: getProvider("vllm"),
          config: {
            agents: {
              defaults: {
                models: {
                  "vllm/manual-model": {},
                },
              },
            },
            models: {
              providers: {
                vllm: {
                  baseUrl: "http://vllm-router.example/v1",
                  apiKey: "VLLM_API_KEY",
                  api: "openai-completions",
                  models: [],
                },
              },
            },
          } as OpenClawConfig,
          env: {
            VLLM_API_KEY: "env-vllm-key",
          } as NodeJS.ProcessEnv,
          resolveProviderApiKey: () => ({
            apiKey: "VLLM_API_KEY",
            discoveryApiKey: "env-vllm-key",
          }),
          resolveProviderAuth: () => ({
            apiKey: "VLLM_API_KEY",
            discoveryApiKey: "env-vllm-key",
            mode: "api_key",
            source: "env",
          }),
        }),
      ).resolves.toBeNull();
      expect(buildVllmProviderMock).not.toHaveBeenCalled();
    });
  });
}

export function describeSglangProviderDiscoveryContract(params: {
  load: ProviderDiscoveryContractPluginLoader;
  apiModuleId: string;
}) {
  describe("sglang provider discovery contract", () => {
    const getProvider = installDiscoveryHooks({
      providerIds: ["sglang"],
      load: params.load,
      sglangApiModuleId: params.apiModuleId,
    });

    it("keeps self-hosted discovery provider-owned", async () => {
      buildSglangProviderMock.mockResolvedValueOnce({
        baseUrl: "http://127.0.0.1:30000/v1",
        api: "openai-completions",
        models: [{ id: "Qwen/Qwen3-8B", name: "Qwen3-8B" }],
      });

      await expect(
        runCatalog({
          provider: getProvider("sglang"),
          config: {},
          env: {
            SGLANG_API_KEY: "env-sglang-key",
          } as NodeJS.ProcessEnv,
          resolveProviderApiKey: () => ({
            apiKey: "SGLANG_API_KEY",
            discoveryApiKey: "env-sglang-key",
          }),
          resolveProviderAuth: () => ({
            apiKey: "SGLANG_API_KEY",
            discoveryApiKey: "env-sglang-key",
            mode: "api_key",
            source: "env",
          }),
        }),
      ).resolves.toEqual({
        provider: {
          baseUrl: "http://127.0.0.1:30000/v1",
          api: "openai-completions",
          apiKey: "SGLANG_API_KEY",
          models: [{ id: "Qwen/Qwen3-8B", name: "Qwen3-8B" }],
        },
      });
      expect(buildSglangProviderMock).toHaveBeenCalledWith({
        apiKey: "env-sglang-key",
      });
    });

    it("uses configured transport only for provider wildcard discovery", async () => {
      buildSglangProviderMock.mockResolvedValueOnce({
        baseUrl: "http://sglang-router.example/v1",
        api: "openai-completions",
        models: [{ id: "Qwen/Qwen3-32B", name: "Qwen3-32B" }],
      });

      await expect(
        runCatalog({
          provider: getProvider("sglang"),
          config: {
            agents: {
              defaults: {
                models: {
                  "sglang/*": {},
                },
              },
            },
            models: {
              providers: {
                sglang: {
                  baseUrl: "http://sglang-router.example/v1",
                  apiKey: "SGLANG_API_KEY",
                  api: "openai-completions",
                  models: [],
                },
              },
            },
          } as OpenClawConfig,
          env: {
            SGLANG_API_KEY: "env-sglang-key",
          } as NodeJS.ProcessEnv,
          resolveProviderApiKey: () => ({
            apiKey: "SGLANG_API_KEY",
            discoveryApiKey: "env-sglang-key",
          }),
          resolveProviderAuth: () => ({
            apiKey: "SGLANG_API_KEY",
            discoveryApiKey: "env-sglang-key",
            mode: "api_key",
            source: "env",
          }),
        }),
      ).resolves.toEqual({
        provider: {
          baseUrl: "http://sglang-router.example/v1",
          api: "openai-completions",
          apiKey: "SGLANG_API_KEY",
          models: [{ id: "Qwen/Qwen3-32B", name: "Qwen3-32B" }],
        },
      });
      expect(buildSglangProviderMock).toHaveBeenCalledWith({
        apiKey: "env-sglang-key",
        baseUrl: "http://sglang-router.example/v1",
      });
    });

    it("keeps explicit self-hosted provider config manual without wildcard visibility", async () => {
      await expect(
        runCatalog({
          provider: getProvider("sglang"),
          config: {
            agents: {
              defaults: {
                models: {
                  "sglang/Qwen/Qwen3-32B": {},
                },
              },
            },
            models: {
              providers: {
                sglang: {
                  baseUrl: "http://sglang-router.example/v1",
                  apiKey: "SGLANG_API_KEY",
                  api: "openai-completions",
                  models: [],
                },
              },
            },
          } as OpenClawConfig,
          env: {
            SGLANG_API_KEY: "env-sglang-key",
          } as NodeJS.ProcessEnv,
          resolveProviderApiKey: () => ({
            apiKey: "SGLANG_API_KEY",
            discoveryApiKey: "env-sglang-key",
          }),
          resolveProviderAuth: () => ({
            apiKey: "SGLANG_API_KEY",
            discoveryApiKey: "env-sglang-key",
            mode: "api_key",
            source: "env",
          }),
        }),
      ).resolves.toBeNull();
      expect(buildSglangProviderMock).not.toHaveBeenCalled();
    });
  });
}

export function describeMinimaxProviderDiscoveryContract(
  load: ProviderDiscoveryContractPluginLoader,
) {
  describe("minimax provider discovery contract", () => {
    const getProvider = installDiscoveryHooks({ providerIds: ["minimax", "minimax-portal"], load });
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            data: [{ id: "MiniMax-M3" }, { id: "MiniMax-M2.7" }, { id: "MiniMax-M2.7-highspeed" }],
          }),
        ),
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    it("keeps API catalog provider-owned", async () => {
      const result = await runProviderCatalog({
        provider: getProvider("minimax"),
        config: {},
        env: {
          MINIMAX_API_KEY: "minimax-key",
        } as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({ apiKey: "minimax-key" }),
        resolveProviderAuth: () => ({
          apiKey: "minimax-key",
          discoveryApiKey: undefined,
          mode: "api_key",
          source: "env",
        }),
      });
      const provider = expectProviderFields(result, {
        baseUrl: "https://api.minimax.io/anthropic",
        api: "anthropic-messages",
        authHeader: true,
        apiKey: "minimax-key",
      });
      const ids = providerModelIds(provider);
      expect(ids).toContain("MiniMax-M3");
      expect(ids).toContain("MiniMax-M2.7");
      expect(ids).toContain("MiniMax-M2.7-highspeed");
    });

    it("keeps portal oauth marker fallback provider-owned", async () => {
      setRuntimeAuthStore({
        version: 1,
        profiles: {
          "minimax-portal:default": {
            type: "oauth",
            provider: "minimax-portal",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
      });

      const result = await runCatalog({
        provider: getProvider("minimax-portal"),
        config: {},
        env: {} as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({ apiKey: undefined }),
        resolveProviderAuth: () => ({
          apiKey: "minimax-oauth",
          discoveryApiKey: "access-token",
          mode: "oauth",
          source: "profile",
          profileId: "minimax-portal:default",
        }),
      });
      const provider = expectProviderFields(result, {
        baseUrl: "https://api.minimax.io/anthropic",
        api: "anthropic-messages",
        authHeader: true,
        apiKey: "minimax-oauth",
      });
      expect(providerModelIds(provider)).toContain("MiniMax-M2.7");
    });

    it("keeps portal explicit base URL override provider-owned", async () => {
      const result = await runProviderCatalog({
        provider: getProvider("minimax-portal"),
        config: {
          models: {
            providers: {
              "minimax-portal": {
                baseUrl: "https://portal-proxy.example.com/anthropic",
                apiKey: "explicit-key",
                models: [],
              },
            },
          },
        },
        env: {} as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({ apiKey: undefined }),
        resolveProviderAuth: () => ({
          apiKey: undefined,
          discoveryApiKey: undefined,
          mode: "none",
          source: "none",
        }),
      });
      expectProviderFields(result, {
        baseUrl: "https://portal-proxy.example.com/anthropic",
        apiKey: "explicit-key",
      });
    });
  });
}

export function describeModelStudioProviderDiscoveryContract(
  load: ProviderDiscoveryContractPluginLoader,
) {
  describe("modelstudio provider discovery contract", () => {
    const getProvider = installDiscoveryHooks({ providerIds: ["qwen"], load });
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            data: [{ id: "qwen3.5-plus" }, { id: "qwen3-max-2026-01-23" }, { id: "MiniMax-M2.5" }],
          }),
        ),
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    it("keeps catalog provider-owned", async () => {
      const result = await runProviderCatalog({
        provider: getProvider("qwen"),
        config: {
          models: {
            providers: {
              modelstudio: {
                baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
                models: [],
              },
            },
          },
        },
        env: {
          MODELSTUDIO_API_KEY: "modelstudio-key",
        } as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({ apiKey: "modelstudio-key" }),
        resolveProviderAuth: () => ({
          apiKey: "modelstudio-key",
          discoveryApiKey: undefined,
          mode: "api_key",
          source: "env",
        }),
      });
      const provider = expectProviderFields(result, {
        baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
        api: "openai-completions",
        apiKey: "modelstudio-key",
      });
      const ids = providerModelIds(provider);
      expect(ids).toContain("qwen3.5-plus");
      expect(ids).toContain("qwen3-max-2026-01-23");
      expect(ids).toContain("MiniMax-M2.5");
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
          config: {},
          env: {} as NodeJS.ProcessEnv,
          resolveProviderApiKey: () => ({ apiKey: undefined }),
          resolveProviderAuth: () => ({
            apiKey: undefined,
            discoveryApiKey: undefined,
            mode: "none",
            source: "none",
          }),
        }),
      ).resolves.toBeNull();
    });

    it("keeps env-managed catalog provider-owned", async () => {
      setRuntimeAuthStore({
        version: 1,
        profiles: {
          "cloudflare-ai-gateway:default": {
            type: "api_key",
            provider: "cloudflare-ai-gateway",
            keyRef: {
              source: "env",
              provider: "default",
              id: "CLOUDFLARE_AI_GATEWAY_API_KEY",
            },
            metadata: {
              accountId: "acc-123",
              gatewayId: "gw-456",
            },
          },
        },
      });

      const result = await runCatalog({
        provider: getProvider("cloudflare-ai-gateway"),
        config: {},
        env: {
          CLOUDFLARE_AI_GATEWAY_API_KEY: "secret-value",
        } as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({ apiKey: undefined }),
        resolveProviderAuth: () => ({
          apiKey: undefined,
          discoveryApiKey: undefined,
          mode: "none",
          source: "none",
        }),
      });
      const provider = expectProviderFields(result, {
        baseUrl: "https://gateway.ai.cloudflare.com/v1/acc-123/gw-456/anthropic",
        api: "anthropic-messages",
        apiKey: "CLOUDFLARE_AI_GATEWAY_API_KEY",
      });
      expect(providerModelIds(provider)).toEqual(["claude-sonnet-4-6"]);
    });
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
