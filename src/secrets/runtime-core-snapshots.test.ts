import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAuthProfileStore, type AuthProfileStore } from "../agents/auth-profiles.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  loadConfig,
  type OpenClawConfig,
} from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "./runtime.js";

type WebProviderUnderTest = "brave" | "gemini" | "grok" | "kimi" | "perplexity" | "firecrawl";

const { resolveExternalAuthProfilesWithPluginsMock, resolvePluginWebSearchProvidersMock } =
  vi.hoisted(() => ({
    resolveExternalAuthProfilesWithPluginsMock: vi.fn(() => []),
    resolvePluginWebSearchProvidersMock: vi.fn(() => buildTestWebSearchProviders()),
  }));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: resolveExternalAuthProfilesWithPluginsMock,
}));

const OPENAI_ENV_KEY_REF = {
  source: "env",
  provider: "default",
  id: "OPENAI_API_KEY",
} as const;

type SecretsRuntimeEnvSnapshot = ReturnType<typeof captureEnv>;

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function loadAuthStoreWithProfiles(profiles: AuthProfileStore["profiles"]): AuthProfileStore {
  return {
    version: 1,
    profiles,
  };
}

function beginSecretsRuntimeIsolationForTest(): SecretsRuntimeEnvSnapshot {
  const envSnapshot = captureEnv([
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    "OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE",
    "OPENCLAW_VERSION",
  ]);
  delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  process.env.OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE = "1";
  delete process.env.OPENCLAW_VERSION;
  return envSnapshot;
}

function endSecretsRuntimeIsolationForTest(envSnapshot: SecretsRuntimeEnvSnapshot) {
  vi.restoreAllMocks();
  envSnapshot.restore();
  setActivePluginRegistry(createEmptyPluginRegistry());
  clearSecretsRuntimeSnapshot();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
}

function createTestProvider(params: {
  id: WebProviderUnderTest;
  pluginId: string;
  order: number;
}): PluginWebSearchProviderEntry {
  const credentialPath = `plugins.entries.${params.pluginId}.config.webSearch.apiKey`;
  const readSearchConfigKey = (searchConfig?: Record<string, unknown>): unknown => {
    const providerConfig =
      searchConfig?.[params.id] && typeof searchConfig[params.id] === "object"
        ? (searchConfig[params.id] as { apiKey?: unknown })
        : undefined;
    return providerConfig?.apiKey ?? searchConfig?.apiKey;
  };
  return {
    pluginId: params.pluginId,
    id: params.id,
    label: params.id,
    hint: `${params.id} test provider`,
    envVars: [`${params.id.toUpperCase()}_API_KEY`],
    placeholder: `${params.id}-...`,
    signupUrl: `https://example.com/${params.id}`,
    autoDetectOrder: params.order,
    credentialPath,
    inactiveSecretPaths: [credentialPath],
    getCredentialValue: readSearchConfigKey,
    setCredentialValue: (searchConfigTarget, value) => {
      const providerConfig =
        params.id === "brave" || params.id === "firecrawl"
          ? searchConfigTarget
          : ((searchConfigTarget[params.id] ??= {}) as { apiKey?: unknown });
      providerConfig.apiKey = value;
    },
    getConfiguredCredentialValue: (config) =>
      (config?.plugins?.entries?.[params.pluginId]?.config as { webSearch?: { apiKey?: unknown } })
        ?.webSearch?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      const plugins = (configTarget.plugins ??= {}) as { entries?: Record<string, unknown> };
      const entries = (plugins.entries ??= {});
      const entry = (entries[params.pluginId] ??= {}) as { config?: Record<string, unknown> };
      const config = (entry.config ??= {});
      const webSearch = (config.webSearch ??= {}) as { apiKey?: unknown };
      webSearch.apiKey = value;
    },
    resolveRuntimeMetadata:
      params.id === "perplexity"
        ? () => ({
            perplexityTransport: "search_api" as const,
          })
        : undefined,
    createTool: () => null,
  };
}

function buildTestWebSearchProviders(): PluginWebSearchProviderEntry[] {
  return [
    createTestProvider({ id: "brave", pluginId: "brave", order: 10 }),
    createTestProvider({ id: "gemini", pluginId: "google", order: 20 }),
    createTestProvider({ id: "grok", pluginId: "xai", order: 30 }),
    createTestProvider({ id: "kimi", pluginId: "moonshot", order: 40 }),
    createTestProvider({ id: "perplexity", pluginId: "perplexity", order: 50 }),
    createTestProvider({ id: "firecrawl", pluginId: "firecrawl", order: 60 }),
  ];
}

describe("secrets runtime snapshot core lanes", () => {
  let envSnapshot: SecretsRuntimeEnvSnapshot;

  beforeEach(() => {
    envSnapshot = beginSecretsRuntimeIsolationForTest();
    resolveExternalAuthProfilesWithPluginsMock.mockReset();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValue([]);
    resolvePluginWebSearchProvidersMock.mockReset();
    resolvePluginWebSearchProvidersMock.mockReturnValue(buildTestWebSearchProviders());
  });

  afterEach(() => {
    endSecretsRuntimeIsolationForTest(envSnapshot);
  });

  async function prepareOpenAiRuntimeSnapshot(params?: { includeAuthStoreRefs?: boolean }) {
    return withEnvAsync(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
        OPENCLAW_VERSION: undefined,
      },
      async () =>
        prepareSecretsRuntimeSnapshot({
          config: asConfig({
            models: {
              providers: {
                openai: {
                  baseUrl: "https://api.openai.com/v1",
                  apiKey: OPENAI_ENV_KEY_REF,
                  models: [],
                },
              },
            },
          }),
          env: { OPENAI_API_KEY: "sk-runtime" },
          agentDirs: ["/tmp/openclaw-agent-main"],
          includeAuthStoreRefs: params?.includeAuthStoreRefs,
          loadablePluginOrigins: new Map(),
          loadAuthStore: () =>
            loadAuthStoreWithProfiles({
              "openai:default": {
                type: "api_key",
                provider: "openai",
                keyRef: OPENAI_ENV_KEY_REF,
              },
            }),
        }),
    );
  }

  it("resolves config env refs for core config surfaces", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              headers: {
                Authorization: {
                  source: "env",
                  provider: "default",
                  id: "OPENAI_PROVIDER_AUTH_HEADER",
                },
              },
              models: [],
            },
          },
        },
        skills: {
          entries: {
            "review-pr": {
              enabled: true,
              apiKey: { source: "env", provider: "default", id: "REVIEW_SKILL_API_KEY" },
            },
          },
        },
      }),
      env: {
        OPENAI_API_KEY: "sk-env-openai",
        OPENAI_PROVIDER_AUTH_HEADER: "Bearer sk-env-header",
        REVIEW_SKILL_API_KEY: "sk-skill-ref",
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    });

    expect(snapshot.config.models?.providers?.openai?.apiKey).toBe("sk-env-openai");
    expect(snapshot.config.models?.providers?.openai?.headers?.Authorization).toBe(
      "Bearer sk-env-header",
    );
    expect(snapshot.config.skills?.entries?.["review-pr"]?.apiKey).toBe("sk-skill-ref");
  });

  it("resolves env refs for memory, talk, and gateway surfaces", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: {
          defaults: {
            memorySearch: {
              remote: {
                apiKey: { source: "env", provider: "default", id: "MEMORY_REMOTE_API_KEY" },
              },
            },
          },
        },
        talk: {
          providers: {
            "acme-speech": {
              apiKey: { source: "env", provider: "default", id: "TALK_PROVIDER_API_KEY" },
            },
          },
        },
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example",
            token: { source: "env", provider: "default", id: "REMOTE_GATEWAY_TOKEN" },
            password: { source: "env", provider: "default", id: "REMOTE_GATEWAY_PASSWORD" },
          },
        },
      }),
      env: {
        MEMORY_REMOTE_API_KEY: "mem-ref-key",
        TALK_PROVIDER_API_KEY: "talk-provider-ref-key",
        REMOTE_GATEWAY_TOKEN: "remote-token-ref",
        REMOTE_GATEWAY_PASSWORD: "remote-password-ref",
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    });

    expect(snapshot.config.agents?.defaults?.memorySearch?.remote?.apiKey).toBe("mem-ref-key");
    expect((snapshot.config.talk as { apiKey?: unknown } | undefined)?.apiKey).toBeUndefined();
    expect(snapshot.config.talk?.providers?.["acme-speech"]?.apiKey).toBe("talk-provider-ref-key");
    expect(snapshot.config.gateway?.remote?.token).toBe("remote-token-ref");
    expect(snapshot.config.gateway?.remote?.password).toBe("remote-password-ref");
  });

  it("resolves env-backed auth profile SecretRefs", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({}),
      env: {
        OPENAI_API_KEY: "sk-env-openai",
        GITHUB_TOKEN: "ghp-env-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadablePluginOrigins: new Map(),
      loadAuthStore: () =>
        loadAuthStoreWithProfiles({
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "old-openai",
            keyRef: OPENAI_ENV_KEY_REF,
          },
          "github-copilot:default": {
            type: "token",
            provider: "github-copilot",
            token: "old-gh",
            tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
          },
        }),
    });

    expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining([
        "/tmp/openclaw-agent-main.auth-profiles.openai:default.key",
        "/tmp/openclaw-agent-main.auth-profiles.github-copilot:default.token",
      ]),
    );
    expect(snapshot.authStores[0]?.store.profiles["openai:default"]).toMatchObject({
      type: "api_key",
      key: "sk-env-openai",
    });
    expect(snapshot.authStores[0]?.store.profiles["github-copilot:default"]).toMatchObject({
      type: "token",
      token: "ghp-env-token",
    });
  });

  it("resolves inline placeholder auth profiles to env refs", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({}),
      env: {
        OPENAI_API_KEY: "sk-env-openai",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadablePluginOrigins: new Map(),
      loadAuthStore: () =>
        loadAuthStoreWithProfiles({
          "openai:inline": {
            type: "api_key",
            provider: "openai",
            key: "${OPENAI_API_KEY}",
          },
        }),
    });

    expect(snapshot.authStores[0]?.store.profiles["openai:inline"]).toMatchObject({
      type: "api_key",
      key: "sk-env-openai",
    });
    const inlineProfile = snapshot.authStores[0]?.store.profiles["openai:inline"] as
      | Record<string, unknown>
      | undefined;
    expect(inlineProfile?.keyRef).toEqual({
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });
  });

  it("activates runtime snapshots for loadConfig", async () => {
    const prepared = await prepareOpenAiRuntimeSnapshot({ includeAuthStoreRefs: false });
    activateSecretsRuntimeSnapshot(prepared);

    expect(loadConfig().models?.providers?.openai?.apiKey).toBe("sk-runtime");
  });

  it("activates runtime snapshots for ensureAuthProfileStore", async () => {
    const prepared = await prepareOpenAiRuntimeSnapshot();
    activateSecretsRuntimeSnapshot(prepared);

    expect(
      ensureAuthProfileStore("/tmp/openclaw-agent-main").profiles["openai:default"],
    ).toMatchObject({
      type: "api_key",
      key: "sk-runtime",
    });
  });
});
