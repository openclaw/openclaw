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

describe("secrets runtime acpx MCP env refs", () => {
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

  it("resolves SecretRef objects for active acpx MCP env vars", async () => {
    const config = asConfig({
      plugins: {
        entries: {
          acpx: {
            enabled: true,
            config: {
              mcpServers: {
                github: {
                  command: "npx",
                  env: {
                    GITHUB_TOKEN: {
                      source: "env",
                      provider: "default",
                      id: "GH_TOKEN_SECRET",
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env: {
        GH_TOKEN_SECRET: "ghp-object-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    const sourceEntries = snapshot.sourceConfig.plugins?.entries as Record<
      string,
      { config?: Record<string, unknown> }
    >;
    const sourceMcpServers = sourceEntries?.acpx?.config?.mcpServers as Record<
      string,
      { env?: Record<string, unknown> }
    >;
    const entries = snapshot.config.plugins?.entries as Record<
      string,
      { config?: Record<string, unknown> }
    >;
    const mcpServers = entries?.acpx?.config?.mcpServers as Record<
      string,
      { env?: Record<string, unknown> }
    >;

    expect(mcpServers?.github?.env?.GITHUB_TOKEN).toBe("ghp-object-token");
    expect(sourceMcpServers?.github?.env?.GITHUB_TOKEN).toEqual({
      source: "env",
      provider: "default",
      id: "GH_TOKEN_SECRET",
    });
  });

  it("resolves inline env-template refs for active acpx MCP env vars", async () => {
    const config = asConfig({
      plugins: {
        entries: {
          acpx: {
            enabled: true,
            config: {
              mcpServers: {
                github: {
                  command: "npx",
                  env: {
                    GITHUB_TOKEN: "${GH_TOKEN_SECRET}",
                    SECOND_TOKEN: "${SECOND_SECRET}",
                    LITERAL: "literal-value",
                  },
                },
              },
            },
          },
        },
      },
    });

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env: {
        GH_TOKEN_SECRET: "ghp-inline-token",
        SECOND_SECRET: "ghp-second-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    const entries = snapshot.config.plugins?.entries as Record<
      string,
      { config?: Record<string, unknown> }
    >;
    const mcpServers = entries?.acpx?.config?.mcpServers as Record<
      string,
      { env?: Record<string, unknown> }
    >;
    expect(mcpServers?.github?.env?.GITHUB_TOKEN).toBe("ghp-inline-token");
    expect(mcpServers?.github?.env?.SECOND_TOKEN).toBe("ghp-second-token");
    expect(mcpServers?.github?.env?.LITERAL).toBe("literal-value");
  });

  it("treats bundled acpx MCP env refs as inactive until the plugin is enabled", async () => {
    const config = asConfig({
      plugins: {
        entries: {
          acpx: {
            config: {
              mcpServers: {
                github: {
                  command: "npx",
                  env: {
                    GITHUB_TOKEN: {
                      source: "env",
                      provider: "default",
                      id: "GH_TOKEN_SECRET",
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(
      snapshot.warnings.some(
        (warning) =>
          warning.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE" &&
          warning.path === "plugins.entries.acpx.config.mcpServers.github.env.GITHUB_TOKEN",
      ),
    ).toBe(true);

    const entries = snapshot.config.plugins?.entries as Record<
      string,
      { config?: Record<string, unknown> }
    >;
    const mcpServers = entries?.acpx?.config?.mcpServers as Record<
      string,
      { env?: Record<string, unknown> }
    >;
    expect(mcpServers?.github?.env?.GITHUB_TOKEN).toEqual({
      source: "env",
      provider: "default",
      id: "GH_TOKEN_SECRET",
    });
  });
});
