import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import { getPath, setPathCreateStrict } from "./path-utils.js";
import { listSecretTargetRegistryEntries } from "./target-registry.js";

type SecretRegistryEntry = ReturnType<typeof listSecretTargetRegistryEntries>[number];

const { resolveBundledPluginWebSearchProvidersMock, resolvePluginWebSearchProvidersMock } =
  vi.hoisted(() => ({
    resolveBundledPluginWebSearchProvidersMock: vi.fn(() => buildTestWebSearchProviders()),
    resolvePluginWebSearchProvidersMock: vi.fn(() => buildTestWebSearchProviders()),
  }));

const mockedModuleIds = [
  "../plugins/web-search-providers.js",
  "../plugins/web-search-providers.runtime.js",
] as const;

let clearSecretsRuntimeSnapshot: typeof import("./runtime.js").clearSecretsRuntimeSnapshot;
let prepareSecretsRuntimeSnapshot: typeof import("./runtime.js").prepareSecretsRuntimeSnapshot;

vi.mock("../plugins/web-search-providers.js", () => ({
  resolveBundledPluginWebSearchProviders: resolveBundledPluginWebSearchProvidersMock,
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
}));

function createTestProvider(params: {
  id: "brave" | "gemini" | "grok" | "kimi" | "perplexity" | "firecrawl" | "tavily";
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
    createTestProvider({ id: "tavily", pluginId: "tavily", order: 70 }),
  ];
}

function toConcretePathSegments(pathPattern: string): string[] {
  const segments = pathPattern.split(".").filter(Boolean);
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "*") {
      out.push("sample");
      continue;
    }
    if (segment.endsWith("[]")) {
      out.push(segment.slice(0, -2), "0");
      continue;
    }
    out.push(segment);
  }
  return out;
}

function buildConfigForOpenClawTarget(entry: SecretRegistryEntry, envId: string): OpenClawConfig {
  const config = {} as OpenClawConfig;
  const refTargetPath =
    entry.secretShape === "sibling_ref" && entry.refPathPattern // pragma: allowlist secret
      ? entry.refPathPattern
      : entry.pathPattern;
  setPathCreateStrict(config, toConcretePathSegments(refTargetPath), {
    source: "env",
    provider: "default",
    id: envId,
  });
  if (entry.id === "gateway.auth.password") {
    setPathCreateStrict(config, ["gateway", "auth", "mode"], "password");
  }
  if (entry.id === "gateway.remote.token" || entry.id === "gateway.remote.password") {
    setPathCreateStrict(config, ["gateway", "mode"], "remote");
    setPathCreateStrict(config, ["gateway", "remote", "url"], "wss://gateway.example");
  }
  if (entry.id === "channels.telegram.webhookSecret") {
    setPathCreateStrict(config, ["channels", "telegram", "webhookUrl"], "https://example.com/hook");
  }
  if (entry.id === "channels.telegram.accounts.*.webhookSecret") {
    setPathCreateStrict(
      config,
      ["channels", "telegram", "accounts", "sample", "webhookUrl"],
      "https://example.com/hook",
    );
  }
  if (entry.id === "channels.slack.signingSecret") {
    setPathCreateStrict(config, ["channels", "slack", "mode"], "http");
  }
  if (entry.id === "channels.slack.accounts.*.signingSecret") {
    setPathCreateStrict(config, ["channels", "slack", "accounts", "sample", "mode"], "http");
  }
  if (entry.id === "channels.zalo.webhookSecret") {
    setPathCreateStrict(config, ["channels", "zalo", "webhookUrl"], "https://example.com/hook");
  }
  if (entry.id === "channels.zalo.accounts.*.webhookSecret") {
    setPathCreateStrict(
      config,
      ["channels", "zalo", "accounts", "sample", "webhookUrl"],
      "https://example.com/hook",
    );
  }
  if (entry.id === "channels.feishu.verificationToken") {
    setPathCreateStrict(config, ["channels", "feishu", "connectionMode"], "webhook");
  }
  if (entry.id === "channels.feishu.encryptKey") {
    setPathCreateStrict(config, ["channels", "feishu", "connectionMode"], "webhook");
  }
  if (entry.id === "channels.feishu.accounts.*.verificationToken") {
    setPathCreateStrict(
      config,
      ["channels", "feishu", "accounts", "sample", "connectionMode"],
      "webhook",
    );
  }
  if (entry.id === "channels.feishu.accounts.*.encryptKey") {
    setPathCreateStrict(
      config,
      ["channels", "feishu", "accounts", "sample", "connectionMode"],
      "webhook",
    );
  }
  if (entry.id === "plugins.entries.brave.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "brave");
  }
  if (entry.id === "tools.web.search.gemini.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "gemini");
  }
  if (entry.id === "plugins.entries.google.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "gemini");
  }
  if (entry.id === "tools.web.search.grok.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "grok");
  }
  if (entry.id === "plugins.entries.xai.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "grok");
  }
  if (entry.id === "tools.web.search.kimi.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "kimi");
  }
  if (entry.id === "plugins.entries.moonshot.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "kimi");
  }
  if (entry.id === "tools.web.search.perplexity.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "perplexity");
  }
  if (entry.id === "plugins.entries.perplexity.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "perplexity");
  }
  if (entry.id === "plugins.entries.firecrawl.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "firecrawl");
  }
  if (entry.id === "plugins.entries.tavily.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "tavily");
  }
  if (entry.id === "tools.code_execution.apiKey") {
    setPathCreateStrict(config, ["tools", "code_execution", "enabled"], true);
  }
  if (entry.id === "tools.web.x_search.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "x_search", "enabled"], true);
  }
  return config;
}

function buildAuthStoreForTarget(entry: SecretRegistryEntry, envId: string): AuthProfileStore {
  if (entry.authProfileType === "token") {
    return {
      version: 1 as const,
      profiles: {
        sample: {
          type: "token" as const,
          provider: "sample-provider",
          token: "legacy-token",
          tokenRef: {
            source: "env" as const,
            provider: "default",
            id: envId,
          },
        },
      },
    };
  }
  return {
    version: 1 as const,
    profiles: {
      sample: {
        type: "api_key" as const,
        provider: "sample-provider",
        key: "legacy-key",
        keyRef: {
          source: "env" as const,
          provider: "default",
          id: envId,
        },
      },
    },
  };
}

describe("secrets runtime target coverage", () => {
  afterEach(() => {
    clearSecretsRuntimeSnapshot();
    resolveBundledPluginWebSearchProvidersMock.mockReset();
    resolvePluginWebSearchProvidersMock.mockReset();
  });

  beforeEach(async () => {
    vi.resetModules();
    ({ clearSecretsRuntimeSnapshot, prepareSecretsRuntimeSnapshot } = await import("./runtime.js"));
  });

  afterAll(() => {
    for (const id of mockedModuleIds) {
      vi.doUnmock(id);
    }
    vi.resetModules();
  });

  it("handles every openclaw.json registry target when configured as active", async () => {
    const entries = listSecretTargetRegistryEntries().filter(
      (entry) => entry.configFile === "openclaw.json",
    );
    for (const [index, entry] of entries.entries()) {
      const envId = `OPENCLAW_SECRET_TARGET_${index}`;
      const expectedValue = `resolved-${entry.id}`;
      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: buildConfigForOpenClawTarget(entry, envId),
        env: { [envId]: expectedValue },
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
      });
      const resolved = getPath(snapshot.config, toConcretePathSegments(entry.pathPattern));
      if (entry.expectedResolvedValue === "string") {
        expect(resolved).toBe(expectedValue);
      } else {
        expect(typeof resolved === "string" || (resolved && typeof resolved === "object")).toBe(
          true,
        );
      }
    }
  });

  it("handles every auth-profiles registry target", async () => {
    const entries = listSecretTargetRegistryEntries().filter(
      (entry) => entry.configFile === "auth-profiles.json",
    );
    for (const [index, entry] of entries.entries()) {
      const envId = `OPENCLAW_AUTH_SECRET_TARGET_${index}`;
      const expectedValue = `resolved-${entry.id}`;
      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: {} as OpenClawConfig,
        env: { [envId]: expectedValue },
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => buildAuthStoreForTarget(entry, envId),
      });
      const store = snapshot.authStores[0]?.store;
      expect(store).toBeDefined();
      const resolved = getPath(store, toConcretePathSegments(entry.pathPattern));
      expect(resolved).toBe(expectedValue);
    }
  });
});
