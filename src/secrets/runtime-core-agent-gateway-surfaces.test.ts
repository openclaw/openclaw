import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";

type WebProviderUnderTest = "brave" | "gemini" | "grok" | "kimi" | "perplexity" | "firecrawl";

const { resolvePluginWebSearchProvidersMock } = vi.hoisted(() => ({
  resolvePluginWebSearchProvidersMock: vi.fn(() => buildTestWebSearchProviders()),
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
}));

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
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

let clearConfigCache: typeof import("../config/config.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let clearSecretsRuntimeSnapshot: typeof import("./runtime.js").clearSecretsRuntimeSnapshot;
let prepareSecretsRuntimeSnapshot: typeof import("./runtime.js").prepareSecretsRuntimeSnapshot;

describe("secrets runtime snapshot agent and gateway surfaces", () => {
  beforeAll(async () => {
    ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js"));
    ({ clearSecretsRuntimeSnapshot, prepareSecretsRuntimeSnapshot } = await import("./runtime.js"));
  });

  beforeEach(() => {
    resolvePluginWebSearchProvidersMock.mockReset();
    resolvePluginWebSearchProvidersMock.mockReturnValue(buildTestWebSearchProviders());
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearSecretsRuntimeSnapshot();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
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
      loadablePluginOrigins: new Map(),
    });

    expect(snapshot.config.agents?.defaults?.memorySearch?.remote?.apiKey).toBe("mem-ref-key");
    expect((snapshot.config.talk as { apiKey?: unknown } | undefined)?.apiKey).toBeUndefined();
    expect(snapshot.config.talk?.providers?.["acme-speech"]?.apiKey).toBe("talk-provider-ref-key");
    expect(snapshot.config.gateway?.remote?.token).toBe("remote-token-ref");
    expect(snapshot.config.gateway?.remote?.password).toBe("remote-password-ref");
  });
});
