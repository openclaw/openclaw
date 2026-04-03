import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";

type WebProviderUnderTest = "brave" | "gemini" | "grok" | "kimi" | "perplexity" | "firecrawl";

const { resolveBundledPluginWebSearchProvidersMock, resolvePluginWebSearchProvidersMock } =
  vi.hoisted(() => ({
    resolveBundledPluginWebSearchProvidersMock: vi.fn(() => buildTestWebSearchProviders()),
    resolvePluginWebSearchProvidersMock: vi.fn(() => buildTestWebSearchProviders()),
  }));

vi.mock("../plugins/web-search-providers.js", () => ({
  resolveBundledPluginWebSearchProviders: resolveBundledPluginWebSearchProvidersMock,
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

const OPENAI_ENV_KEY_REF = { source: "env", provider: "default", id: "OPENAI_API_KEY" } as const;

let clearConfigCache: typeof import("../config/config.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let activateSecretsRuntimeSnapshot: typeof import("./runtime.js").activateSecretsRuntimeSnapshot;
let clearSecretsRuntimeSnapshot: typeof import("./runtime.js").clearSecretsRuntimeSnapshot;
let getActiveRuntimeWebToolsMetadata: typeof import("./runtime.js").getActiveRuntimeWebToolsMetadata;
let prepareSecretsRuntimeSnapshot: typeof import("./runtime.js").prepareSecretsRuntimeSnapshot;

function createOpenAiFileModelsConfig(): NonNullable<OpenClawConfig["models"]> {
  return {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: { source: "file", provider: "default", id: "/providers/openai/apiKey" },
        models: [],
      },
    },
  };
}

function loadAuthStoreWithProfiles(profiles: AuthProfileStore["profiles"]): AuthProfileStore {
  return {
    version: 1,
    profiles,
  };
}

describe("secrets runtime snapshot", () => {
  beforeAll(async () => {
    ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js"));
    ({
      activateSecretsRuntimeSnapshot,
      clearSecretsRuntimeSnapshot,
      getActiveRuntimeWebToolsMetadata,
      prepareSecretsRuntimeSnapshot,
    } = await import("./runtime.js"));
  });

  beforeEach(() => {
    resolveBundledPluginWebSearchProvidersMock.mockReset();
    resolveBundledPluginWebSearchProvidersMock.mockReturnValue(buildTestWebSearchProviders());
    resolvePluginWebSearchProvidersMock.mockReset();
    resolvePluginWebSearchProvidersMock.mockReturnValue(buildTestWebSearchProviders());
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearSecretsRuntimeSnapshot();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  });

  it("resolves env refs for config and auth profiles", async () => {
    const config = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            remote: {
              apiKey: { source: "env", provider: "default", id: "MEMORY_REMOTE_API_KEY" },
            },
          },
        },
      },
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
      talk: {
        apiKey: { source: "env", provider: "default", id: "TALK_API_KEY" },
        providers: {
          elevenlabs: {
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
      channels: {
        telegram: {
          botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN_REF" },
          webhookUrl: "https://example.test/telegram-webhook",
          webhookSecret: { source: "env", provider: "default", id: "TELEGRAM_WEBHOOK_SECRET_REF" },
          accounts: {
            work: {
              botToken: {
                source: "env",
                provider: "default",
                id: "TELEGRAM_WORK_BOT_TOKEN_REF",
              },
            },
          },
        },
        slack: {
          mode: "http",
          signingSecret: { source: "env", provider: "default", id: "SLACK_SIGNING_SECRET_REF" },
          accounts: {
            work: {
              botToken: { source: "env", provider: "default", id: "SLACK_WORK_BOT_TOKEN_REF" },
              appToken: { source: "env", provider: "default", id: "SLACK_WORK_APP_TOKEN_REF" },
            },
          },
        },
      },
      tools: {
        web: {
          search: {
            apiKey: { source: "env", provider: "default", id: "WEB_SEARCH_API_KEY" },
          },
        },
      },
    });

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env: {
        OPENAI_API_KEY: "sk-env-openai", // pragma: allowlist secret
        OPENAI_PROVIDER_AUTH_HEADER: "Bearer sk-env-header", // pragma: allowlist secret
        GITHUB_TOKEN: "ghp-env-token", // pragma: allowlist secret
        REVIEW_SKILL_API_KEY: "sk-skill-ref", // pragma: allowlist secret
        MEMORY_REMOTE_API_KEY: "mem-ref-key", // pragma: allowlist secret
        TALK_API_KEY: "talk-ref-key", // pragma: allowlist secret
        TALK_PROVIDER_API_KEY: "talk-provider-ref-key", // pragma: allowlist secret
        REMOTE_GATEWAY_TOKEN: "remote-token-ref",
        REMOTE_GATEWAY_PASSWORD: "remote-password-ref", // pragma: allowlist secret
        TELEGRAM_BOT_TOKEN_REF: "telegram-bot-ref",
        TELEGRAM_WEBHOOK_SECRET_REF: "telegram-webhook-ref", // pragma: allowlist secret
        TELEGRAM_WORK_BOT_TOKEN_REF: "telegram-work-ref",
        SLACK_SIGNING_SECRET_REF: "slack-signing-ref", // pragma: allowlist secret
        SLACK_WORK_BOT_TOKEN_REF: "slack-work-bot-ref",
        SLACK_WORK_APP_TOKEN_REF: "slack-work-app-ref",
        WEB_SEARCH_API_KEY: "web-search-ref", // pragma: allowlist secret
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
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
          "openai:inline": {
            type: "api_key",
            provider: "openai",
            key: "${OPENAI_API_KEY}",
          },
        }),
    });

    expect(snapshot.config.models?.providers?.openai?.apiKey).toBe("sk-env-openai");
    expect(snapshot.config.models?.providers?.openai?.headers?.Authorization).toBe(
      "Bearer sk-env-header",
    );
    expect(snapshot.config.skills?.entries?.["review-pr"]?.apiKey).toBe("sk-skill-ref");
    expect(snapshot.config.agents?.defaults?.memorySearch?.remote?.apiKey).toBe("mem-ref-key");
    expect(snapshot.config.talk?.apiKey).toBe("talk-ref-key");
    expect(snapshot.config.talk?.providers?.elevenlabs?.apiKey).toBe("talk-provider-ref-key");
    expect(snapshot.config.gateway?.remote?.token).toBe("remote-token-ref");
    expect(snapshot.config.gateway?.remote?.password).toBe("remote-password-ref");
    expect(snapshot.config.channels?.telegram?.botToken).toEqual({
      source: "env",
      provider: "default",
      id: "TELEGRAM_BOT_TOKEN_REF",
    });
    expect(snapshot.config.channels?.telegram?.webhookSecret).toBe("telegram-webhook-ref");
    expect(snapshot.config.channels?.telegram?.accounts?.work?.botToken).toBe("telegram-work-ref");
    expect(snapshot.config.channels?.slack?.signingSecret).toBe("slack-signing-ref");
    expect(snapshot.config.channels?.slack?.accounts?.work?.botToken).toBe("slack-work-bot-ref");
    expect(snapshot.config.channels?.slack?.accounts?.work?.appToken).toEqual({
      source: "env",
      provider: "default",
      id: "SLACK_WORK_APP_TOKEN_REF",
    });
    expect(snapshot.config.tools?.web?.search?.apiKey).toBe("web-search-ref");
    expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining(["channels.slack.accounts.work.appToken"]),
    );
    expect(snapshot.authStores[0]?.store.profiles["openai:default"]).toMatchObject({
      type: "api_key",
      key: "sk-env-openai",
    });
    expect(snapshot.authStores[0]?.store.profiles["github-copilot:default"]).toMatchObject({
      type: "token",
      token: "ghp-env-token",
    });
    expect(snapshot.authStores[0]?.store.profiles["openai:inline"]).toMatchObject({
      type: "api_key",
      key: "sk-env-openai",
    });
    // After normalization, inline SecretRef string should be promoted to keyRef
    expect(
      (snapshot.authStores[0].store.profiles["openai:inline"] as Record<string, unknown>).keyRef,
    ).toEqual({ source: "env", provider: "default", id: "OPENAI_API_KEY" });
  });

  it("resolves top-level Matrix accessToken refs even when named accounts exist", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          matrix: {
            accessToken: {
              source: "env",
              provider: "default",
              id: "MATRIX_ACCESS_TOKEN",
            },
            accounts: {
              ops: {
                homeserver: "https://matrix.example.org",
                accessToken: "ops-token",
              },
            },
          },
        },
      }),
      env: {
        MATRIX_ACCESS_TOKEN: "default-matrix-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.matrix?.accessToken).toBe("default-matrix-token");
  });

  it("can skip auth-profile SecretRef resolution when includeAuthStoreRefs is false", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_AUTH_PROFILE_SECRET_${Date.now()}`;
    delete process.env[missingEnvVar];

    const loadAuthStore = () =>
      loadAuthStoreWithProfiles({
        "custom:token": {
          type: "token",
          provider: "custom",
          tokenRef: { source: "env", provider: "default", id: missingEnvVar },
        },
      });

    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({}),
        env: {},
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore,
      }),
    ).rejects.toThrow(`Environment variable "${missingEnvVar}" is missing or empty.`);

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({}),
      env: {},
      includeAuthStoreRefs: false,
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore,
    });

    expect(snapshot.authStores).toEqual([]);
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
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.matrix?.accounts?.ops?.password).toEqual({
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
      loadAuthStore: () => ({ version: 1, profiles: {} }),
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
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.matrix?.accounts?.default?.password).toEqual({
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

  it("resolves sandbox ssh secret refs for active ssh backends", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "ssh",
              ssh: {
                target: "peter@example.com:22",
                identityData: { source: "env", provider: "default", id: "SSH_IDENTITY_DATA" },
                certificateData: {
                  source: "env",
                  provider: "default",
                  id: "SSH_CERTIFICATE_DATA",
                },
                knownHostsData: {
                  source: "env",
                  provider: "default",
                  id: "SSH_KNOWN_HOSTS_DATA",
                },
              },
            },
          },
        },
      }),
      env: {
        SSH_IDENTITY_DATA: "PRIVATE KEY",
        SSH_CERTIFICATE_DATA: "SSH CERT",
        SSH_KNOWN_HOSTS_DATA: "example.com ssh-ed25519 AAAATEST",
      },
    });

    expect(snapshot.config.agents?.defaults?.sandbox?.ssh).toMatchObject({
      identityData: "PRIVATE KEY",
      certificateData: "SSH CERT",
      knownHostsData: "example.com ssh-ed25519 AAAATEST",
    });
  });

  it("treats sandbox ssh secret refs as inactive when ssh backend is not selected", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "docker",
              ssh: {
                identityData: { source: "env", provider: "default", id: "SSH_IDENTITY_DATA" },
              },
            },
          },
        },
      }),
      env: {},
    });

    expect(snapshot.config.agents?.defaults?.sandbox?.ssh?.identityData).toEqual({
      source: "env",
      provider: "default",
      id: "SSH_IDENTITY_DATA",
    });
    expect(snapshot.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: "agents.defaults.sandbox.ssh.identityData",
        }),
      ]),
    );
  });

  it("normalizes inline SecretRef object on token to tokenRef", async () => {
    const config: OpenClawConfig = { models: {}, secrets: {} };
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env: { MY_TOKEN: "resolved-token-value" },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () =>
        loadAuthStoreWithProfiles({
          "custom:inline-token": {
            type: "token",
            provider: "custom",
            token: { source: "env", provider: "default", id: "MY_TOKEN" } as unknown as string,
          },
        }),
    });

    const profile = snapshot.authStores[0]?.store.profiles["custom:inline-token"] as Record<
      string,
      unknown
    >;
    // tokenRef should be set from the inline SecretRef
    expect(profile.tokenRef).toEqual({ source: "env", provider: "default", id: "MY_TOKEN" });
    // token should be resolved to the actual value after activation
    activateSecretsRuntimeSnapshot(snapshot);
    expect(profile.token).toBe("resolved-token-value");
  });

  it("normalizes inline SecretRef object on key to keyRef", async () => {
    const config: OpenClawConfig = { models: {}, secrets: {} };
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env: { MY_KEY: "resolved-key-value" },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () =>
        loadAuthStoreWithProfiles({
          "custom:inline-key": {
            type: "api_key",
            provider: "custom",
            key: { source: "env", provider: "default", id: "MY_KEY" } as unknown as string,
          },
        }),
    });

    const profile = snapshot.authStores[0]?.store.profiles["custom:inline-key"] as Record<
      string,
      unknown
    >;
    // keyRef should be set from the inline SecretRef
    expect(profile.keyRef).toEqual({ source: "env", provider: "default", id: "MY_KEY" });
    // key should be resolved to the actual value after activation
    activateSecretsRuntimeSnapshot(snapshot);
    expect(profile.key).toBe("resolved-key-value");
  });

  it("keeps explicit keyRef when inline key SecretRef is also present", async () => {
    const config: OpenClawConfig = { models: {}, secrets: {} };
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env: {
        PRIMARY_KEY: "primary-key-value",
        SHADOW_KEY: "shadow-key-value",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () =>
        loadAuthStoreWithProfiles({
          "custom:explicit-keyref": {
            type: "api_key",
            provider: "custom",
            keyRef: { source: "env", provider: "default", id: "PRIMARY_KEY" },
            key: { source: "env", provider: "default", id: "SHADOW_KEY" } as unknown as string,
          },
        }),
    });

    const profile = snapshot.authStores[0]?.store.profiles["custom:explicit-keyref"] as Record<
      string,
      unknown
    >;
    expect(profile.keyRef).toEqual({ source: "env", provider: "default", id: "PRIMARY_KEY" });
    activateSecretsRuntimeSnapshot(snapshot);
    expect(profile.key).toBe("primary-key-value");
  });

  it("treats non-selected web search provider refs as inactive", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "brave",
              apiKey: { source: "env", provider: "default", id: "WEB_SEARCH_API_KEY" },
            },
          },
        },
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "MISSING_GROK_API_KEY" },
                },
              },
            },
          },
        },
      }),
      env: {
        WEB_SEARCH_API_KEY: "web-search-ref", // pragma: allowlist secret
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.tools?.web?.search?.apiKey).toBe("web-search-ref");
    const xaiWebSearchConfig = snapshot.config.plugins?.entries?.xai?.config as
      | { webSearch?: { apiKey?: unknown } }
      | undefined;
    expect(xaiWebSearchConfig?.webSearch?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_GROK_API_KEY",
    });
    expect(snapshot.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: "plugins.entries.xai.config.webSearch.apiKey",
        }),
      ]),
    );
  });

  it("keeps non-selected provider refs inactive in web search auto mode", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
              apiKey: { source: "env", provider: "default", id: "WEB_SEARCH_API_KEY" },
            },
          },
        },
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: {
                    source: "env",
                    provider: "default",
                    id: "WEB_SEARCH_GEMINI_API_KEY",
                  },
                },
              },
            },
          },
        },
      }),
      env: {
        WEB_SEARCH_API_KEY: "web-search-ref", // pragma: allowlist secret
        WEB_SEARCH_GEMINI_API_KEY: "web-search-gemini-ref", // pragma: allowlist secret
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.tools?.web?.search?.apiKey).toBe("web-search-ref");
    const googleWebSearchConfig = snapshot.config.plugins?.entries?.google?.config as
      | { webSearch?: { apiKey?: unknown } }
      | undefined;
    expect(googleWebSearchConfig?.webSearch?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "WEB_SEARCH_GEMINI_API_KEY",
    });
    expect(snapshot.webTools.search.selectedProvider).toBe("brave");
    expect(snapshot.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: "plugins.entries.google.config.webSearch.apiKey",
        }),
      ]),
    );
  });

  it("resolves selected web search provider ref even when provider config is disabled", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "gemini",
            },
          },
        },
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  enabled: false,
                  apiKey: {
                    source: "env",
                    provider: "default",
                    id: "WEB_SEARCH_GEMINI_API_KEY",
                  },
                },
              },
            },
          },
        },
      }),
      env: {
        WEB_SEARCH_GEMINI_API_KEY: "web-search-gemini-ref", // pragma: allowlist secret
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });
    const resolvedGoogleWebSearchConfig = snapshot.config.plugins?.entries?.google?.config as
      | { webSearch?: { apiKey?: unknown } }
      | undefined;
    expect(resolvedGoogleWebSearchConfig?.webSearch?.apiKey).toBe("web-search-gemini-ref");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "plugins.entries.google.config.webSearch.apiKey",
    );
  });

  it("fails fast at startup when selected web search provider ref is unresolved", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          tools: {
            web: {
              search: {
                enabled: true,
                provider: "gemini",
              },
            },
          },
          plugins: {
            entries: {
              google: {
                config: {
                  webSearch: {
                    apiKey: {
                      source: "env",
                      provider: "default",
                      id: "MISSING_WEB_SEARCH_GEMINI_API_KEY",
                    },
                  },
                },
              },
            },
          },
        }),
        env: {},
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
      }),
    ).rejects.toThrow("[WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK]");
  });

  it("exposes active runtime web tool metadata as a defensive clone", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            search: {
              provider: "gemini",
            },
          },
        },
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: {
                    source: "env",
                    provider: "default",
                    id: "WEB_SEARCH_GEMINI_API_KEY",
                  },
                },
              },
            },
          },
        },
      }),
      env: {
        WEB_SEARCH_GEMINI_API_KEY: "web-search-gemini-ref", // pragma: allowlist secret
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    activateSecretsRuntimeSnapshot(snapshot);

    const first = getActiveRuntimeWebToolsMetadata();
    expect(first?.search.providerConfigured).toBe("gemini");
    expect(first?.search.selectedProvider).toBe("gemini");
    expect(first?.search.selectedProviderKeySource).toBe("secretRef");
    if (!first) {
      throw new Error("missing runtime web tools metadata");
    }
    first.search.providerConfigured = "brave";
    first.search.selectedProvider = "brave";

    const second = getActiveRuntimeWebToolsMetadata();
    expect(second?.search.providerConfigured).toBe("gemini");
    expect(second?.search.selectedProvider).toBe("gemini");
  });

  it("resolves model provider request secret refs for headers, auth, and tls material", async () => {
    const config = asConfig({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            request: {
              headers: {
                "X-Tenant": { source: "env", provider: "default", id: "OPENAI_PROVIDER_TENANT" },
              },
              auth: {
                mode: "authorization-bearer",
                token: { source: "env", provider: "default", id: "OPENAI_PROVIDER_TOKEN" },
              },
              proxy: {
                mode: "explicit-proxy",
                url: "http://proxy.example:8080",
                tls: {
                  ca: { source: "env", provider: "default", id: "OPENAI_PROVIDER_PROXY_CA" },
                },
              },
              tls: {
                cert: { source: "env", provider: "default", id: "OPENAI_PROVIDER_CERT" },
                key: { source: "env", provider: "default", id: "OPENAI_PROVIDER_KEY" },
              },
            },
            models: [],
          },
        },
      },
    });

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env: {
        OPENAI_PROVIDER_TENANT: "tenant-acme",
        OPENAI_PROVIDER_TOKEN: "sk-provider-runtime", // pragma: allowlist secret
        OPENAI_PROVIDER_PROXY_CA: "proxy-ca",
        OPENAI_PROVIDER_CERT: "client-cert",
        OPENAI_PROVIDER_KEY: "client-key",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.models?.providers?.openai?.request).toEqual({
      headers: {
        "X-Tenant": "tenant-acme",
      },
      auth: {
        mode: "authorization-bearer",
        token: "sk-provider-runtime",
      },
      proxy: {
        mode: "explicit-proxy",
        url: "http://proxy.example:8080",
        tls: {
          ca: "proxy-ca",
        },
      },
      tls: {
        cert: "client-cert",
        key: "client-key",
      },
    });
  });

  it("resolves file refs via configured file provider", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-file-provider-"));
    const secretsPath = path.join(root, "secrets.json");
    try {
      await fs.writeFile(
        secretsPath,
        JSON.stringify(
          {
            providers: {
              openai: {
                apiKey: "sk-from-file-provider", // pragma: allowlist secret
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      await fs.chmod(secretsPath, 0o600);

      const config = asConfig({
        secrets: {
          providers: {
            default: {
              source: "file",
              path: secretsPath,
              mode: "json",
            },
          },
          defaults: {
            file: "default",
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "file", provider: "default", id: "/providers/openai/apiKey" },
              models: [],
            },
          },
        },
      });

      const snapshot = await prepareSecretsRuntimeSnapshot({
        config,
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
      });

      expect(snapshot.config.models?.providers?.openai?.apiKey).toBe("sk-from-file-provider");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails when file provider payload is not a JSON object", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-file-provider-bad-"));
    const secretsPath = path.join(root, "secrets.json");
    try {
      await fs.writeFile(secretsPath, JSON.stringify(["not-an-object"]), "utf8");
      await fs.chmod(secretsPath, 0o600);

      await expect(
        prepareSecretsRuntimeSnapshot({
          config: asConfig({
            secrets: {
              providers: {
                default: {
                  source: "file",
                  path: secretsPath,
                  mode: "json",
                },
              },
            },
            models: {
              ...createOpenAiFileModelsConfig(),
            },
          }),
          agentDirs: ["/tmp/openclaw-agent-main"],
          loadAuthStore: () => ({ version: 1, profiles: {} }),
        }),
      ).rejects.toThrow("payload is not a JSON object");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("skips inactive-surface refs and emits diagnostics", async () => {
    const config = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            enabled: false,
            remote: {
              apiKey: { source: "env", provider: "default", id: "DISABLED_MEMORY_API_KEY" },
            },
          },
        },
      },
      gateway: {
        auth: {
          mode: "token",
          password: { source: "env", provider: "default", id: "DISABLED_GATEWAY_PASSWORD" },
        },
      },
      channels: {
        telegram: {
          botToken: { source: "env", provider: "default", id: "DISABLED_TELEGRAM_BASE_TOKEN" },
          accounts: {
            disabled: {
              enabled: false,
              botToken: {
                source: "env",
                provider: "default",
                id: "DISABLED_TELEGRAM_ACCOUNT_TOKEN",
              },
            },
          },
        },
      },
      tools: {
        web: {
          search: {
            enabled: false,
            apiKey: { source: "env", provider: "default", id: "DISABLED_WEB_SEARCH_API_KEY" },
          },
        },
      },
      plugins: {
        entries: {
          google: {
            config: {
              webSearch: {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "DISABLED_WEB_SEARCH_GEMINI_API_KEY",
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

    expect(snapshot.config.channels?.telegram?.botToken).toEqual({
      source: "env",
      provider: "default",
      id: "DISABLED_TELEGRAM_BASE_TOKEN",
    });
    const ignoredInactiveWarnings = snapshot.warnings.filter(
      (warning) => warning.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
    );
    expect(ignoredInactiveWarnings).toHaveLength(6);
    expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining([
        "agents.defaults.memorySearch.remote.apiKey",
        "gateway.auth.password",
        "channels.telegram.botToken",
        "channels.telegram.accounts.disabled.botToken",
        "plugins.entries.brave.config.webSearch.apiKey",
        "plugins.entries.google.config.webSearch.apiKey",
      ]),
    );
  });

  it("treats gateway.remote refs as inactive when local auth credentials are configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        gateway: {
          mode: "local",
          auth: {
            mode: "password",
            token: "local-token",
            password: "local-password", // pragma: allowlist secret
          },
          remote: {
            enabled: true,
            token: { source: "env", provider: "default", id: "MISSING_REMOTE_TOKEN" },
            password: { source: "env", provider: "default", id: "MISSING_REMOTE_PASSWORD" },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.gateway?.remote?.token).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_REMOTE_TOKEN",
    });
    expect(snapshot.config.gateway?.remote?.password).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_REMOTE_PASSWORD",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining(["gateway.remote.token", "gateway.remote.password"]),
    );
  });

  it("treats gateway.auth.password ref as active when mode is unset and no token is configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        gateway: {
          auth: {
            password: { source: "env", provider: "default", id: "GATEWAY_PASSWORD_REF" },
          },
        },
      }),
      env: {
        GATEWAY_PASSWORD_REF: "resolved-gateway-password", // pragma: allowlist secret
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.gateway?.auth?.password).toBe("resolved-gateway-password");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain("gateway.auth.password");
  });

  it("treats gateway.auth.token ref as active when token mode is explicit", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        gateway: {
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "GATEWAY_TOKEN_REF" },
          },
        },
      }),
      env: {
        GATEWAY_TOKEN_REF: "resolved-gateway-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.gateway?.auth?.token).toBe("resolved-gateway-token");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain("gateway.auth.token");
  });

  it("treats gateway.auth.token ref as inactive when password mode is explicit", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        gateway: {
          auth: {
            mode: "password",
            token: { source: "env", provider: "default", id: "GATEWAY_TOKEN_REF" },
            password: "password-123", // pragma: allowlist secret
          },
        },
      }),
      env: {
        GATEWAY_TOKEN_REF: "resolved-gateway-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.gateway?.auth?.token).toEqual({
      source: "env",
      provider: "default",
      id: "GATEWAY_TOKEN_REF",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain("gateway.auth.token");
  });

  it("fails when gateway.auth.token ref is active and unresolved", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          gateway: {
            auth: {
              mode: "token",
              token: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN_REF" },
            },
          },
        }),
        env: {},
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
      }),
    ).rejects.toThrow(/MISSING_GATEWAY_TOKEN_REF/i);
  });

  it("resolves media request secret refs for provider headers, auth, and tls material", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          media: {
            models: [
              {
                provider: "openai",
                model: "gpt-4o-mini-transcribe",
                capabilities: ["audio"],
                request: {
                  headers: {
                    "X-Shared-Tenant": {
                      source: "env",
                      provider: "default",
                      id: "MEDIA_SHARED_TENANT",
                    },
                  },
                  auth: {
                    mode: "header",
                    headerName: "x-shared-key",
                    value: {
                      source: "env",
                      provider: "default",
                      id: "MEDIA_SHARED_MODEL_KEY",
                    },
                  },
                },
              },
            ],
            audio: {
              enabled: true,
              request: {
                headers: {
                  "X-Tenant": { source: "env", provider: "default", id: "MEDIA_AUDIO_TENANT" },
                },
                auth: {
                  mode: "authorization-bearer",
                  token: { source: "env", provider: "default", id: "MEDIA_AUDIO_TOKEN" },
                },
                tls: {
                  cert: { source: "env", provider: "default", id: "MEDIA_AUDIO_CERT" },
                },
              },
              models: [
                {
                  provider: "deepgram",
                  request: {
                    auth: {
                      mode: "header",
                      headerName: "x-api-key",
                      value: { source: "env", provider: "default", id: "MEDIA_AUDIO_MODEL_KEY" },
                    },
                    proxy: {
                      mode: "explicit-proxy",
                      url: "http://proxy.example:8080",
                      tls: {
                        ca: { source: "env", provider: "default", id: "MEDIA_AUDIO_PROXY_CA" },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      }),
      env: {
        MEDIA_SHARED_TENANT: "tenant-shared",
        MEDIA_SHARED_MODEL_KEY: "shared-model-key", // pragma: allowlist secret
        MEDIA_AUDIO_TENANT: "tenant-acme",
        MEDIA_AUDIO_TOKEN: "audio-token", // pragma: allowlist secret
        MEDIA_AUDIO_CERT: "client-cert",
        MEDIA_AUDIO_MODEL_KEY: "model-key", // pragma: allowlist secret
        MEDIA_AUDIO_PROXY_CA: "proxy-ca",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.tools?.media?.audio?.request?.headers?.["X-Tenant"]).toBe("tenant-acme");
    expect(snapshot.config.tools?.media?.audio?.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: "audio-token",
    });
    expect(snapshot.config.tools?.media?.audio?.request?.tls).toEqual({
      cert: "client-cert",
    });
    expect(snapshot.config.tools?.media?.models?.[0]?.request).toEqual({
      headers: {
        "X-Shared-Tenant": "tenant-shared",
      },
      auth: {
        mode: "header",
        headerName: "x-shared-key",
        value: "shared-model-key",
      },
    });
    expect(snapshot.config.tools?.media?.audio?.models?.[0]?.request).toEqual({
      auth: {
        mode: "header",
        headerName: "x-api-key",
        value: "model-key",
      },
      proxy: {
        mode: "explicit-proxy",
        url: "http://proxy.example:8080",
        tls: {
          ca: "proxy-ca",
        },
      },
    });
  });

  it("resolves shared media model request refs when capability blocks are omitted", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          media: {
            models: [
              {
                provider: "openai",
                model: "gpt-4o-mini-transcribe",
                capabilities: ["audio"],
                request: {
                  auth: {
                    mode: "authorization-bearer",
                    token: {
                      source: "env",
                      provider: "default",
                      id: "MEDIA_SHARED_AUDIO_TOKEN",
                    },
                  },
                },
              },
            ],
          },
        },
      }),
      env: {
        MEDIA_SHARED_AUDIO_TOKEN: "shared-audio-token", // pragma: allowlist secret
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.tools?.media?.models?.[0]?.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: "shared-audio-token",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "tools.media.models.0.request.auth.token",
    );
  });

  it("treats shared media model request refs as inactive when their capabilities are disabled", async () => {
    const sharedTokenRef = {
      source: "env" as const,
      provider: "default" as const,
      id: "MEDIA_DISABLED_AUDIO_TOKEN",
    };
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          media: {
            models: [
              {
                provider: "openai",
                model: "gpt-4o-mini-transcribe",
                capabilities: ["audio"],
                request: {
                  auth: {
                    mode: "authorization-bearer",
                    token: sharedTokenRef,
                  },
                },
              },
            ],
            audio: {
              enabled: false,
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.tools?.media?.models?.[0]?.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: sharedTokenRef,
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "tools.media.models.0.request.auth.token",
    );
  });

  it("resolves shared media model request refs from inferred provider capabilities", async () => {
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.mediaUnderstandingProviders.push({
      pluginId: "deepgram",
      pluginName: "Deepgram Plugin",
      source: "test",
      provider: {
        id: "deepgram",
        capabilities: ["audio"],
      },
    });
    setActivePluginRegistry(pluginRegistry);

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          media: {
            models: [
              {
                provider: "deepgram",
                request: {
                  auth: {
                    mode: "authorization-bearer",
                    token: {
                      source: "env",
                      provider: "default",
                      id: "MEDIA_INFERRED_AUDIO_TOKEN",
                    },
                  },
                },
              },
            ],
          },
        },
      }),
      env: {
        MEDIA_INFERRED_AUDIO_TOKEN: "inferred-audio-token", // pragma: allowlist secret
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.tools?.media?.models?.[0]?.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: "inferred-audio-token",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "tools.media.models.0.request.auth.token",
    );
  });

  it("treats shared media model request refs as inactive when inferred capabilities are disabled", async () => {
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.mediaUnderstandingProviders.push({
      pluginId: "deepgram",
      pluginName: "Deepgram Plugin",
      source: "test",
      provider: {
        id: "deepgram",
        capabilities: ["audio"],
      },
    });
    setActivePluginRegistry(pluginRegistry);

    const inferredTokenRef = {
      source: "env" as const,
      provider: "default" as const,
      id: "MEDIA_INFERRED_DISABLED_AUDIO_TOKEN",
    };
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          media: {
            models: [
              {
                provider: "deepgram",
                request: {
                  auth: {
                    mode: "authorization-bearer",
                    token: inferredTokenRef,
                  },
                },
              },
            ],
            audio: {
              enabled: false,
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.tools?.media?.models?.[0]?.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: inferredTokenRef,
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "tools.media.models.0.request.auth.token",
    );
  });

  it("treats section media model request refs as inactive when model capabilities exclude the section", async () => {
    const sectionTokenRef = {
      source: "env" as const,
      provider: "default" as const,
      id: "MEDIA_AUDIO_SECTION_FILTERED_TOKEN",
    };
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          media: {
            audio: {
              enabled: true,
              models: [
                {
                  provider: "openai",
                  capabilities: ["video"],
                  request: {
                    auth: {
                      mode: "authorization-bearer",
                      token: sectionTokenRef,
                    },
                  },
                },
              ],
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.tools?.media?.audio?.models?.[0]?.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: sectionTokenRef,
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "tools.media.audio.models.0.request.auth.token",
    );
  });

  it("fails when an active exec ref id contains traversal segments", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          talk: {
            apiKey: { source: "exec", provider: "vault", id: "a/../b" },
          },
          secrets: {
            providers: {
              vault: {
                source: "exec",
                command: process.execPath,
              },
            },
          },
        }),
        env: {},
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
      }),
    ).rejects.toThrow(/must not include "\." or "\.\." path segments/i);
  });

  it("treats gateway.auth.password ref as inactive when auth mode is trusted-proxy", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        gateway: {
          auth: {
            mode: "trusted-proxy",
            password: { source: "env", provider: "default", id: "GATEWAY_PASSWORD_REF" },
          },
        },
      }),
      env: {
        GATEWAY_PASSWORD_REF: "resolved-gateway-password", // pragma: allowlist secret
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.gateway?.auth?.password).toEqual({
      source: "env",
      provider: "default",
      id: "GATEWAY_PASSWORD_REF",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain("gateway.auth.password");
  });

  it("treats gateway.auth.password ref as inactive when remote token is configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        gateway: {
          mode: "local",
          auth: {
            password: { source: "env", provider: "default", id: "GATEWAY_PASSWORD_REF" },
          },
          remote: {
            token: { source: "env", provider: "default", id: "REMOTE_GATEWAY_TOKEN" },
          },
        },
      }),
      env: {
        REMOTE_GATEWAY_TOKEN: "remote-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.gateway?.auth?.password).toEqual({
      source: "env",
      provider: "default",
      id: "GATEWAY_PASSWORD_REF",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain("gateway.auth.password");
  });

  it.each(["none", "trusted-proxy"] as const)(
    "treats gateway.remote refs as inactive in local mode when auth mode is %s",
    async (mode) => {
      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: asConfig({
          gateway: {
            mode: "local",
            auth: {
              mode,
            },
            remote: {
              token: { source: "env", provider: "default", id: "MISSING_REMOTE_TOKEN" },
              password: { source: "env", provider: "default", id: "MISSING_REMOTE_PASSWORD" },
            },
          },
        }),
        env: {},
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
      });

      expect(snapshot.config.gateway?.remote?.token).toEqual({
        source: "env",
        provider: "default",
        id: "MISSING_REMOTE_TOKEN",
      });
      expect(snapshot.config.gateway?.remote?.password).toEqual({
        source: "env",
        provider: "default",
        id: "MISSING_REMOTE_PASSWORD",
      });
      expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
        expect.arrayContaining(["gateway.remote.token", "gateway.remote.password"]),
      );
    },
  );

  it("treats gateway.remote.token ref as active in local mode when no local credentials are configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        gateway: {
          mode: "local",
          auth: {},
          remote: {
            enabled: true,
            token: { source: "env", provider: "default", id: "REMOTE_TOKEN" },
            password: { source: "env", provider: "default", id: "REMOTE_PASSWORD" },
          },
        },
      }),
      env: {
        REMOTE_TOKEN: "resolved-remote-token",
        REMOTE_PASSWORD: "resolved-remote-password", // pragma: allowlist secret
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.gateway?.remote?.token).toBe("resolved-remote-token");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain("gateway.remote.token");
    expect(snapshot.warnings.map((warning) => warning.path)).toContain("gateway.remote.password");
  });

  it("treats gateway.remote.password ref as active in local mode when password can win", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        gateway: {
          mode: "local",
          auth: {},
          remote: {
            enabled: true,
            password: { source: "env", provider: "default", id: "REMOTE_PASSWORD" },
          },
        },
      }),
      env: {
        REMOTE_PASSWORD: "resolved-remote-password", // pragma: allowlist secret
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.gateway?.remote?.password).toBe("resolved-remote-password");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "gateway.remote.password",
    );
  });

  it("treats top-level Zalo botToken refs as active even when tokenFile is configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          zalo: {
            botToken: { source: "env", provider: "default", id: "ZALO_BOT_TOKEN" },
            tokenFile: "/tmp/missing-zalo-token-file",
          },
        },
      }),
      env: {
        ZALO_BOT_TOKEN: "resolved-zalo-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.zalo?.botToken).toBe("resolved-zalo-token");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.zalo.botToken",
    );
  });

  it("treats account-level Zalo botToken refs as active even when tokenFile is configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          zalo: {
            accounts: {
              work: {
                botToken: { source: "env", provider: "default", id: "ZALO_WORK_BOT_TOKEN" },
                tokenFile: "/tmp/missing-zalo-work-token-file",
              },
            },
          },
        },
      }),
      env: {
        ZALO_WORK_BOT_TOKEN: "resolved-zalo-work-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.zalo?.accounts?.work?.botToken).toBe(
      "resolved-zalo-work-token",
    );
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.zalo.accounts.work.botToken",
    );
  });

  it("treats top-level Zalo botToken refs as active for non-default accounts without overrides", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          zalo: {
            botToken: { source: "env", provider: "default", id: "ZALO_TOP_LEVEL_TOKEN" },
            accounts: {
              work: {
                enabled: true,
              },
            },
          },
        },
      }),
      env: {
        ZALO_TOP_LEVEL_TOKEN: "resolved-zalo-top-level-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.zalo?.botToken).toBe("resolved-zalo-top-level-token");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.zalo.botToken",
    );
  });

  it("treats channels.zalo.accounts.default.botToken refs as active", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          zalo: {
            accounts: {
              default: {
                enabled: true,
                botToken: { source: "env", provider: "default", id: "ZALO_DEFAULT_TOKEN" },
              },
            },
          },
        },
      }),
      env: {
        ZALO_DEFAULT_TOKEN: "resolved-zalo-default-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.zalo?.accounts?.default?.botToken).toBe(
      "resolved-zalo-default-token",
    );
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.zalo.accounts.default.botToken",
    );
  });

  it("treats top-level Nextcloud Talk botSecret and apiPassword refs as active when file paths are configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          "nextcloud-talk": {
            botSecret: { source: "env", provider: "default", id: "NEXTCLOUD_BOT_SECRET" },
            botSecretFile: "/tmp/missing-nextcloud-bot-secret-file",
            apiUser: "bot-user",
            apiPassword: { source: "env", provider: "default", id: "NEXTCLOUD_API_PASSWORD" },
            apiPasswordFile: "/tmp/missing-nextcloud-api-password-file",
          },
        },
      }),
      env: {
        NEXTCLOUD_BOT_SECRET: "resolved-nextcloud-bot-secret", // pragma: allowlist secret
        NEXTCLOUD_API_PASSWORD: "resolved-nextcloud-api-password", // pragma: allowlist secret
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.["nextcloud-talk"]?.botSecret).toBe(
      "resolved-nextcloud-bot-secret",
    );
    expect(snapshot.config.channels?.["nextcloud-talk"]?.apiPassword).toBe(
      "resolved-nextcloud-api-password",
    );
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.nextcloud-talk.botSecret",
    );
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.nextcloud-talk.apiPassword",
    );
  });

  it("treats account-level Nextcloud Talk botSecret and apiPassword refs as active when file paths are configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          "nextcloud-talk": {
            accounts: {
              work: {
                botSecret: { source: "env", provider: "default", id: "NEXTCLOUD_WORK_BOT_SECRET" },
                botSecretFile: "/tmp/missing-nextcloud-work-bot-secret-file",
                apiPassword: {
                  source: "env",
                  provider: "default",
                  id: "NEXTCLOUD_WORK_API_PASSWORD",
                },
                apiPasswordFile: "/tmp/missing-nextcloud-work-api-password-file",
              },
            },
          },
        },
      }),
      env: {
        NEXTCLOUD_WORK_BOT_SECRET: "resolved-nextcloud-work-bot-secret", // pragma: allowlist secret
        NEXTCLOUD_WORK_API_PASSWORD: "resolved-nextcloud-work-api-password", // pragma: allowlist secret
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.["nextcloud-talk"]?.accounts?.work?.botSecret).toBe(
      "resolved-nextcloud-work-bot-secret",
    );
    expect(snapshot.config.channels?.["nextcloud-talk"]?.accounts?.work?.apiPassword).toBe(
      "resolved-nextcloud-work-api-password",
    );
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.nextcloud-talk.accounts.work.botSecret",
    );
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.nextcloud-talk.accounts.work.apiPassword",
    );
  });

  it("treats gateway.remote refs as active when tailscale serve is enabled", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        gateway: {
          mode: "local",
          tailscale: { mode: "serve" },
          remote: {
            enabled: true,
            token: { source: "env", provider: "default", id: "REMOTE_GATEWAY_TOKEN" },
            password: { source: "env", provider: "default", id: "REMOTE_GATEWAY_PASSWORD" },
          },
        },
      }),
      env: {
        REMOTE_GATEWAY_TOKEN: "tailscale-remote-token",
        REMOTE_GATEWAY_PASSWORD: "tailscale-remote-password", // pragma: allowlist secret
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.gateway?.remote?.token).toBe("tailscale-remote-token");
    expect(snapshot.config.gateway?.remote?.password).toBe("tailscale-remote-password");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain("gateway.remote.token");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "gateway.remote.password",
    );
  });

  it("treats defaults memorySearch ref as inactive when all enabled agents disable memorySearch", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: {
          defaults: {
            memorySearch: {
              remote: {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "DEFAULT_MEMORY_REMOTE_API_KEY",
                },
              },
            },
          },
          list: [
            {
              enabled: true,
              memorySearch: {
                enabled: false,
              },
            },
          ],
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.agents?.defaults?.memorySearch?.remote?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "DEFAULT_MEMORY_REMOTE_API_KEY",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "agents.defaults.memorySearch.remote.apiKey",
    );
  });

  it("fails when enabled channel surfaces contain unresolved refs", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          channels: {
            telegram: {
              botToken: {
                source: "env",
                provider: "default",
                id: "MISSING_ENABLED_TELEGRAM_TOKEN",
              },
              accounts: {
                work: {
                  enabled: true,
                },
              },
            },
          },
        }),
        env: {},
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
      }),
    ).rejects.toThrow('Environment variable "MISSING_ENABLED_TELEGRAM_TOKEN" is missing or empty.');
  });

  it("fails when default Telegram account can inherit an unresolved top-level token ref", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          channels: {
            telegram: {
              botToken: {
                source: "env",
                provider: "default",
                id: "MISSING_ENABLED_TELEGRAM_TOKEN",
              },
              accounts: {
                default: {
                  enabled: true,
                },
              },
            },
          },
        }),
        env: {},
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
      }),
    ).rejects.toThrow('Environment variable "MISSING_ENABLED_TELEGRAM_TOKEN" is missing or empty.');
  });

  it("treats top-level Telegram token as inactive when all enabled accounts override it", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          telegram: {
            botToken: {
              source: "env",
              provider: "default",
              id: "UNUSED_TELEGRAM_BASE_TOKEN",
            },
            accounts: {
              work: {
                enabled: true,
                botToken: {
                  source: "env",
                  provider: "default",
                  id: "TELEGRAM_WORK_TOKEN",
                },
              },
              disabled: {
                enabled: false,
              },
            },
          },
        },
      }),
      env: {
        TELEGRAM_WORK_TOKEN: "telegram-work-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.telegram?.accounts?.work?.botToken).toBe(
      "telegram-work-token",
    );
    expect(snapshot.config.channels?.telegram?.botToken).toEqual({
      source: "env",
      provider: "default",
      id: "UNUSED_TELEGRAM_BASE_TOKEN",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.telegram.botToken",
    );
  });

  it("treats Telegram account overrides as enabled when account.enabled is omitted", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          channels: {
            telegram: {
              enabled: true,
              accounts: {
                inheritedEnabled: {
                  botToken: {
                    source: "env",
                    provider: "default",
                    id: "MISSING_INHERITED_TELEGRAM_ACCOUNT_TOKEN",
                  },
                },
              },
            },
          },
        }),
        env: {},
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
      }),
    ).rejects.toThrow(
      'Environment variable "MISSING_INHERITED_TELEGRAM_ACCOUNT_TOKEN" is missing or empty.',
    );
  });

  it("treats Telegram webhookSecret refs as inactive when webhook mode is not configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          telegram: {
            webhookSecret: {
              source: "env",
              provider: "default",
              id: "MISSING_TELEGRAM_WEBHOOK_SECRET",
            },
            accounts: {
              work: {
                enabled: true,
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.telegram?.webhookSecret).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_TELEGRAM_WEBHOOK_SECRET",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.telegram.webhookSecret",
    );
  });

  it("treats Telegram top-level botToken refs as inactive when tokenFile is configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          telegram: {
            tokenFile: "/tmp/telegram-bot-token",
            botToken: {
              source: "env",
              provider: "default",
              id: "MISSING_TELEGRAM_BOT_TOKEN",
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.telegram?.botToken).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_TELEGRAM_BOT_TOKEN",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.telegram.botToken",
    );
  });

  it("treats Telegram account botToken refs as inactive when account tokenFile is configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          telegram: {
            accounts: {
              work: {
                enabled: true,
                tokenFile: "/tmp/telegram-work-bot-token",
                botToken: {
                  source: "env",
                  provider: "default",
                  id: "MISSING_TELEGRAM_WORK_BOT_TOKEN",
                },
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.telegram?.accounts?.work?.botToken).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_TELEGRAM_WORK_BOT_TOKEN",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.telegram.accounts.work.botToken",
    );
  });

  it("treats top-level Telegram botToken refs as active when account botToken is blank", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          telegram: {
            botToken: {
              source: "env",
              provider: "default",
              id: "TELEGRAM_BASE_TOKEN",
            },
            accounts: {
              work: {
                enabled: true,
                botToken: "",
              },
            },
          },
        },
      }),
      env: {
        TELEGRAM_BASE_TOKEN: "telegram-base-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.telegram?.botToken).toBe("telegram-base-token");
    expect(snapshot.config.channels?.telegram?.accounts?.work?.botToken).toBe("");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.telegram.botToken",
    );
  });

  it("treats IRC account nickserv password refs as inactive when nickserv is disabled", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          irc: {
            accounts: {
              work: {
                enabled: true,
                nickserv: {
                  enabled: false,
                  password: {
                    source: "env",
                    provider: "default",
                    id: "MISSING_IRC_WORK_NICKSERV_PASSWORD",
                  },
                },
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.irc?.accounts?.work?.nickserv?.password).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_IRC_WORK_NICKSERV_PASSWORD",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.irc.accounts.work.nickserv.password",
    );
  });

  it("treats top-level IRC nickserv password refs as inactive when nickserv is disabled", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          irc: {
            nickserv: {
              enabled: false,
              password: {
                source: "env",
                provider: "default",
                id: "MISSING_IRC_TOPLEVEL_NICKSERV_PASSWORD",
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.irc?.nickserv?.password).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_IRC_TOPLEVEL_NICKSERV_PASSWORD",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.irc.nickserv.password",
    );
  });

  it("treats Slack signingSecret refs as inactive when mode is socket", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          slack: {
            mode: "socket",
            signingSecret: {
              source: "env",
              provider: "default",
              id: "MISSING_SLACK_SIGNING_SECRET",
            },
            accounts: {
              work: {
                enabled: true,
                mode: "socket",
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.slack?.signingSecret).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_SLACK_SIGNING_SECRET",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.slack.signingSecret",
    );
  });

  it("treats Slack appToken refs as inactive when mode is http", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          slack: {
            mode: "http",
            appToken: {
              source: "env",
              provider: "default",
              id: "MISSING_SLACK_APP_TOKEN",
            },
            accounts: {
              work: {
                enabled: true,
                mode: "http",
                appToken: {
                  source: "env",
                  provider: "default",
                  id: "MISSING_SLACK_WORK_APP_TOKEN",
                },
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.slack?.appToken).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_SLACK_APP_TOKEN",
    });
    expect(snapshot.config.channels?.slack?.accounts?.work?.appToken).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_SLACK_WORK_APP_TOKEN",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining(["channels.slack.appToken", "channels.slack.accounts.work.appToken"]),
    );
  });

  it("treats top-level Google Chat serviceAccount as inactive when enabled accounts use serviceAccountRef", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          googlechat: {
            serviceAccount: {
              source: "env",
              provider: "default",
              id: "MISSING_GOOGLECHAT_BASE_SERVICE_ACCOUNT",
            },
            accounts: {
              work: {
                enabled: true,
                serviceAccountRef: {
                  source: "env",
                  provider: "default",
                  id: "GOOGLECHAT_WORK_SERVICE_ACCOUNT",
                },
              },
            },
          },
        },
      }),
      env: {
        GOOGLECHAT_WORK_SERVICE_ACCOUNT: "work-service-account-json",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.googlechat?.serviceAccount).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_GOOGLECHAT_BASE_SERVICE_ACCOUNT",
    });
    expect(snapshot.config.channels?.googlechat?.accounts?.work?.serviceAccount).toBe(
      "work-service-account-json",
    );
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.googlechat.serviceAccount",
    );
  });

  it("fails when non-default Discord account inherits an unresolved top-level token ref", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          channels: {
            discord: {
              token: {
                source: "env",
                provider: "default",
                id: "MISSING_DISCORD_BASE_TOKEN",
              },
              accounts: {
                work: {
                  enabled: true,
                },
              },
            },
          },
        }),
        env: {},
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
      }),
    ).rejects.toThrow('Environment variable "MISSING_DISCORD_BASE_TOKEN" is missing or empty.');
  });

  it("treats top-level Discord token refs as inactive when account token is explicitly blank", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          discord: {
            token: {
              source: "env",
              provider: "default",
              id: "MISSING_DISCORD_DEFAULT_TOKEN",
            },
            accounts: {
              default: {
                enabled: true,
                token: "",
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.discord?.token).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_DISCORD_DEFAULT_TOKEN",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain("channels.discord.token");
  });

  it("treats Discord PluralKit token refs as inactive when PluralKit is disabled", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          discord: {
            pluralkit: {
              enabled: false,
              token: {
                source: "env",
                provider: "default",
                id: "MISSING_DISCORD_PLURALKIT_TOKEN",
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.discord?.pluralkit?.token).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_DISCORD_PLURALKIT_TOKEN",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.discord.pluralkit.token",
    );
  });

  it("treats Discord voice TTS refs as inactive when voice is disabled", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          discord: {
            voice: {
              enabled: false,
              tts: {
                openai: {
                  apiKey: {
                    source: "env",
                    provider: "default",
                    id: "MISSING_DISCORD_VOICE_TTS_OPENAI",
                  },
                },
              },
            },
            accounts: {
              work: {
                enabled: true,
                voice: {
                  enabled: false,
                  tts: {
                    openai: {
                      apiKey: {
                        source: "env",
                        provider: "default",
                        id: "MISSING_DISCORD_WORK_VOICE_TTS_OPENAI",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.discord?.voice?.tts?.providers?.openai?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_DISCORD_VOICE_TTS_OPENAI",
    });
    expect(
      snapshot.config.channels?.discord?.accounts?.work?.voice?.tts?.providers?.openai?.apiKey,
    ).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_DISCORD_WORK_VOICE_TTS_OPENAI",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining([
        "channels.discord.voice.tts.providers.openai.apiKey",
        "channels.discord.accounts.work.voice.tts.providers.openai.apiKey",
      ]),
    );
  });

  it("handles Discord nested inheritance for enabled and disabled accounts", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          discord: {
            voice: {
              tts: {
                providers: {
                  openai: {
                    apiKey: { source: "env", provider: "default", id: "DISCORD_BASE_TTS_OPENAI" },
                  },
                },
              },
            },
            pluralkit: {
              token: { source: "env", provider: "default", id: "DISCORD_BASE_PK_TOKEN" },
            },
            accounts: {
              enabledInherited: {
                enabled: true,
              },
              enabledOverride: {
                enabled: true,
                voice: {
                  tts: {
                    providers: {
                      openai: {
                        apiKey: {
                          source: "env",
                          provider: "default",
                          id: "DISCORD_ENABLED_OVERRIDE_TTS_OPENAI",
                        },
                      },
                    },
                  },
                },
              },
              disabledOverride: {
                enabled: false,
                voice: {
                  tts: {
                    providers: {
                      openai: {
                        apiKey: {
                          source: "env",
                          provider: "default",
                          id: "DISCORD_DISABLED_OVERRIDE_TTS_OPENAI",
                        },
                      },
                    },
                  },
                },
                pluralkit: {
                  token: {
                    source: "env",
                    provider: "default",
                    id: "DISCORD_DISABLED_OVERRIDE_PK_TOKEN",
                  },
                },
              },
            },
          },
        },
      }),
      env: {
        DISCORD_BASE_TTS_OPENAI: "base-tts-openai",
        DISCORD_BASE_PK_TOKEN: "base-pk-token",
        DISCORD_ENABLED_OVERRIDE_TTS_OPENAI: "enabled-override-tts-openai",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.channels?.discord?.voice?.tts?.providers?.openai?.apiKey).toBe(
      "base-tts-openai",
    );
    expect(snapshot.config.channels?.discord?.pluralkit?.token).toBe("base-pk-token");
    expect(
      snapshot.config.channels?.discord?.accounts?.enabledOverride?.voice?.tts?.providers?.openai
        ?.apiKey,
    ).toBe("enabled-override-tts-openai");
    expect(
      snapshot.config.channels?.discord?.accounts?.disabledOverride?.voice?.tts?.providers?.openai
        ?.apiKey,
    ).toEqual({
      source: "env",
      provider: "default",
      id: "DISCORD_DISABLED_OVERRIDE_TTS_OPENAI",
    });
    expect(snapshot.config.channels?.discord?.accounts?.disabledOverride?.pluralkit?.token).toEqual(
      {
        source: "env",
        provider: "default",
        id: "DISCORD_DISABLED_OVERRIDE_PK_TOKEN",
      },
    );
    expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining([
        "channels.discord.accounts.disabledOverride.voice.tts.providers.openai.apiKey",
        "channels.discord.accounts.disabledOverride.pluralkit.token",
      ]),
    );
  });

  it("skips top-level Discord voice refs when all enabled accounts override nested voice config", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          discord: {
            voice: {
              tts: {
                providers: {
                  openai: {
                    apiKey: {
                      source: "env",
                      provider: "default",
                      id: "DISCORD_UNUSED_BASE_TTS_OPENAI",
                    },
                  },
                },
              },
            },
            accounts: {
              enabledOverride: {
                enabled: true,
                voice: {
                  tts: {
                    providers: {
                      openai: {
                        apiKey: {
                          source: "env",
                          provider: "default",
                          id: "DISCORD_ENABLED_ONLY_TTS_OPENAI",
                        },
                      },
                    },
                  },
                },
              },
              disabledInherited: {
                enabled: false,
              },
            },
          },
        },
      }),
      env: {
        DISCORD_ENABLED_ONLY_TTS_OPENAI: "enabled-only-tts-openai",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(
      snapshot.config.channels?.discord?.accounts?.enabledOverride?.voice?.tts?.providers?.openai
        ?.apiKey,
    ).toBe("enabled-only-tts-openai");
    expect(snapshot.config.channels?.discord?.voice?.tts?.providers?.openai?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "DISCORD_UNUSED_BASE_TTS_OPENAI",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.discord.voice.tts.providers.openai.apiKey",
    );
  });

  it("fails when an enabled Discord account override has an unresolved nested ref", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          channels: {
            discord: {
              voice: {
                tts: {
                  providers: {
                    openai: {
                      apiKey: { source: "env", provider: "default", id: "DISCORD_BASE_TTS_OK" },
                    },
                  },
                },
              },
              accounts: {
                enabledOverride: {
                  enabled: true,
                  voice: {
                    tts: {
                      providers: {
                        openai: {
                          apiKey: {
                            source: "env",
                            provider: "default",
                            id: "DISCORD_ENABLED_OVERRIDE_TTS_MISSING",
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
        env: {
          DISCORD_BASE_TTS_OK: "base-tts-openai",
        },
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
      }),
    ).rejects.toThrow(
      'Environment variable "DISCORD_ENABLED_OVERRIDE_TTS_MISSING" is missing or empty.',
    );
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

  it("does not write inherited auth stores during runtime secret activation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-runtime-"));
    const stateDir = path.join(root, ".openclaw");
    const mainAgentDir = path.join(stateDir, "agents", "main", "agent");
    const workerStorePath = path.join(stateDir, "agents", "worker", "agent", "auth-profiles.json");
    const prevStateDir = process.env.OPENCLAW_STATE_DIR;

    try {
      await fs.mkdir(mainAgentDir, { recursive: true });
      await fs.writeFile(
        path.join(mainAgentDir, "auth-profiles.json"),
        JSON.stringify({
          ...loadAuthStoreWithProfiles({
            "openai:default": {
              type: "api_key",
              provider: "openai",
              keyRef: OPENAI_ENV_KEY_REF,
            },
          }),
        }),
        "utf8",
      );
      process.env.OPENCLAW_STATE_DIR = stateDir;

      await prepareSecretsRuntimeSnapshot({
        config: {
          agents: {
            list: [{ id: "worker" }],
          },
        },
        env: { OPENAI_API_KEY: "sk-runtime-worker" }, // pragma: allowlist secret
      });

      await expect(fs.access(workerStorePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (prevStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = prevStateDir;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("migrates legacy x_search SecretRefs into the xai plugin webSearch auth at runtime", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            x_search: {
              apiKey: { source: "env", provider: "default", id: "X_SEARCH_KEY_REF" },
              enabled: true,
              model: "grok-4-1-fast",
            },
          },
        },
      }),
      env: {
        X_SEARCH_KEY_REF: "xai-runtime-key",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect((snapshot.config.tools?.web as Record<string, unknown> | undefined)?.x_search).toEqual({
      enabled: true,
      model: "grok-4-1-fast",
    });
    expect(snapshot.config.plugins?.entries?.xai?.config).toEqual({
      webSearch: {
        apiKey: "xai-runtime-key",
      },
    });
  });

  it("still migrates legacy x_search auth when general legacy migration returns an invalid config", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            x_search: {
              apiKey: { source: "env", provider: "default", id: "X_SEARCH_KEY_REF" },
              enabled: true,
            },
          },
        },
        channels: {
          telegram: {
            groupMentionsOnly: true,
            groups: [],
          },
        },
      }),
      env: {
        X_SEARCH_KEY_REF: "xai-runtime-key-invalid-config",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect((snapshot.config.tools?.web as Record<string, unknown> | undefined)?.x_search).toEqual({
      enabled: true,
    });
    expect(snapshot.config.plugins?.entries?.xai?.config).toEqual({
      webSearch: {
        apiKey: "xai-runtime-key-invalid-config",
      },
    });
  });

  it("does not force-enable xai at runtime for knob-only x_search config", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            x_search: {
              enabled: true,
              model: "grok-4-1-fast",
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect((snapshot.config.tools?.web as Record<string, unknown> | undefined)?.x_search).toEqual({
      enabled: true,
      model: "grok-4-1-fast",
    });
    expect(snapshot.config.plugins?.entries?.xai).toBeUndefined();
  });
});
