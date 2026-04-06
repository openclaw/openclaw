import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as matrixSecrets from "../../extensions/matrix/src/secret-contract.ts";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
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

vi.mock("../channels/plugins/bootstrap-registry.js", () => {
  return {
    getBootstrapChannelPlugin: (id: string) =>
      id === "matrix"
        ? {
            secrets: {
              collectRuntimeConfigAssignments: matrixSecrets.collectRuntimeConfigAssignments,
            },
          }
        : undefined,
    getBootstrapChannelSecrets: (id: string) =>
      id === "matrix"
        ? {
            collectRuntimeConfigAssignments: matrixSecrets.collectRuntimeConfigAssignments,
          }
        : undefined,
  };
});

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

function loadAuthStoreWithProfiles(profiles: AuthProfileStore["profiles"]): AuthProfileStore {
  return {
    version: 1,
    profiles,
  };
}

describe("secrets runtime snapshot matrix shadowing", () => {
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

  it("ignores Matrix password refs that are shadowed by scoped env access tokens", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          matrix: {
            accounts: {
              ops: {
                password: {
                  source: "env",
                  provider: "default",
                  id: "MATRIX_OPS_PASSWORD",
                },
              },
            },
          },
        },
      }),
      env: {
        MATRIX_OPS_ACCESS_TOKEN: "ops-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(
      (snapshot.config.channels?.matrix?.accounts?.ops as { password?: unknown } | undefined)
        ?.password,
    ).toEqual({
      source: "env",
      provider: "default",
      id: "MATRIX_OPS_PASSWORD",
    });
    expect(snapshot.warnings).toContainEqual(
      expect.objectContaining({
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.matrix.accounts.ops.password",
      }),
    );
  });

  it.each([
    {
      name: "channels.matrix.accounts.default.accessToken config",
      config: {
        channels: {
          matrix: {
            password: {
              source: "env",
              provider: "default",
              id: "MATRIX_PASSWORD",
            },
            accounts: {
              default: {
                accessToken: "default-token",
              },
            },
          },
        },
      },
      env: {},
    },
    {
      name: "channels.matrix.accounts.default.accessToken SecretRef config",
      config: {
        channels: {
          matrix: {
            password: {
              source: "env",
              provider: "default",
              id: "MATRIX_PASSWORD",
            },
            accounts: {
              default: {
                accessToken: {
                  source: "env",
                  provider: "default",
                  id: "MATRIX_DEFAULT_ACCESS_TOKEN_REF",
                },
              },
            },
          },
        },
      },
      env: {
        MATRIX_DEFAULT_ACCESS_TOKEN_REF: "default-token",
      },
    },
    {
      name: "MATRIX_DEFAULT_ACCESS_TOKEN env auth",
      config: {
        channels: {
          matrix: {
            password: {
              source: "env",
              provider: "default",
              id: "MATRIX_PASSWORD",
            },
          },
        },
      },
      env: {
        MATRIX_DEFAULT_ACCESS_TOKEN: "default-token",
      },
    },
  ])("ignores top-level Matrix password refs shadowed by $name", async ({ config, env }) => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig(config),
      env,
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.matrix?.password).toEqual({
      source: "env",
      provider: "default",
      id: "MATRIX_PASSWORD",
    });
    expect(snapshot.warnings).toContainEqual(
      expect.objectContaining({
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.matrix.password",
      }),
    );
  });

  it.each([
    {
      name: "top-level Matrix accessToken config",
      config: {
        channels: {
          matrix: {
            accessToken: "default-token",
            accounts: {
              default: {
                password: {
                  source: "env",
                  provider: "default",
                  id: "MATRIX_DEFAULT_PASSWORD",
                },
              },
            },
          },
        },
      },
      env: {},
    },
    {
      name: "top-level Matrix accessToken SecretRef config",
      config: {
        channels: {
          matrix: {
            accessToken: {
              source: "env",
              provider: "default",
              id: "MATRIX_ACCESS_TOKEN_REF",
            },
            accounts: {
              default: {
                password: {
                  source: "env",
                  provider: "default",
                  id: "MATRIX_DEFAULT_PASSWORD",
                },
              },
            },
          },
        },
      },
      env: {
        MATRIX_ACCESS_TOKEN_REF: "default-token",
      },
    },
    {
      name: "MATRIX_ACCESS_TOKEN env auth",
      config: {
        channels: {
          matrix: {
            accounts: {
              default: {
                password: {
                  source: "env",
                  provider: "default",
                  id: "MATRIX_DEFAULT_PASSWORD",
                },
              },
            },
          },
        },
      },
      env: {
        MATRIX_ACCESS_TOKEN: "default-token",
      },
    },
  ])("ignores default-account Matrix password refs shadowed by $name", async ({ config, env }) => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig(config),
      env,
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(
      (snapshot.config.channels?.matrix?.accounts?.default as { password?: unknown } | undefined)
        ?.password,
    ).toEqual({
      source: "env",
      provider: "default",
      id: "MATRIX_DEFAULT_PASSWORD",
    });
    expect(snapshot.warnings).toContainEqual(
      expect.objectContaining({
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.matrix.accounts.default.password",
      }),
    );
  });
});
