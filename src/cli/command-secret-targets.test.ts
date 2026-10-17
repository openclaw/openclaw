import { describe, expect, it, vi } from "vitest";

const REGISTRY_IDS = [
  "memory.search.remote.apiKey",
  "agents.entries.*.memory.search.remote.apiKey",
  "channels.discord.token",
  "channels.discord.accounts.*.token",
  "channels.telegram.botToken",
  "gateway.auth.token",
  "gateway.auth.password",
  "gateway.remote.token",
  "gateway.remote.password",
  "models.providers.*.apiKey",
  "tts.providers.openai.apiKey",
  "plugins.entries.voice-call.config.twilio.authToken",
  "plugins.entries.firecrawl.config.webFetch.apiKey",
  "plugins.entries.firecrawl.config.webSearch.apiKey",
  "plugins.entries.brave.config.webSearch.apiKey",
  "plugins.entries.exa.config.webSearch.apiKey",
  "plugins.entries.gemini.config.webSearch.apiKey",
  "plugins.entries.other-fetch.config.webFetch.apiKey",
  "plugins.entries.other-fetch.config.webSearch.apiKey",
  "skills.entries.demo.apiKey",
] as const;

function readPath(source: unknown, path: string): unknown {
  let current = source;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function webProvider(
  pluginId: string,
  capability: "webFetch" | "webSearch",
  autoDetectOrder: number,
) {
  const credentialPath = `plugins.entries.${pluginId}.config.${capability}.apiKey`;
  return {
    pluginId,
    id: pluginId,
    autoDetectOrder,
    credentialPath,
    getConfiguredCredentialValue: (config?: unknown) => readPath(config, credentialPath),
    getConfiguredCredentialFallback: (): undefined => undefined,
    getCredentialValue: (): undefined => undefined,
  };
}

vi.mock("../secrets/target-registry.js", () => ({
  listSecretTargetRegistryEntries: vi.fn(() =>
    REGISTRY_IDS.map((id) => ({
      id,
      pathPattern: id,
    })),
  ),
  discoverConfigSecretTargetsByIds: vi.fn((config: unknown, targetIds?: Iterable<string>) => {
    const allowed = targetIds ? new Set(targetIds) : null;
    const out: Array<{ entry: { id: string }; path: string; pathSegments: string[] }> = [];
    const matches = (pattern: string, path: string): boolean => {
      const patternSegments = pattern.split(".");
      const pathSegments = path.split(".");
      if (patternSegments.length !== pathSegments.length) {
        return false;
      }
      return patternSegments.every(
        (segment, index) => segment === "*" || segment === pathSegments[index],
      );
    };
    const collectPaths = (node: unknown, segments: string[], prefix: string[] = []): string[] => {
      const [segment, ...rest] = segments;
      if (!segment) {
        return node === undefined ? [] : [prefix.join(".")];
      }
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        return [];
      }
      if (segment === "*") {
        return Object.entries(node).flatMap(([key, value]) =>
          collectPaths(value, rest, [...prefix, key]),
        );
      }
      return collectPaths((node as Record<string, unknown>)[segment], rest, [...prefix, segment]);
    };
    const record = (targetId: string, path: string) => {
      if (allowed && !allowed.has(targetId)) {
        return;
      }
      out.push({ entry: { id: targetId }, path, pathSegments: path.split(".") });
    };
    for (const id of REGISTRY_IDS) {
      if (id.includes("*")) {
        for (const path of collectPaths(config, id.split("."))) {
          if (matches(id, path)) {
            record(id, path);
          }
        }
        continue;
      }
      if (readPath(config, id) !== undefined) {
        record(id, id);
      }
    }
    return out;
  }),
}));

vi.mock("../plugins/web-fetch-providers.runtime.js", () => ({
  resolvePluginWebFetchProviders: vi.fn((params: { config?: Record<string, unknown> }) => [
    {
      ...webProvider("firecrawl", "webFetch", 50),
      getConfiguredCredentialFallback: () => ({
        path: "plugins.entries.firecrawl.config.webSearch.apiKey",
        value: readPath(params.config, "plugins.entries.firecrawl.config.webSearch.apiKey"),
      }),
      getCredentialValue: (fetchConfig?: { firecrawl?: { apiKey?: unknown } }) =>
        fetchConfig?.firecrawl?.apiKey,
    },
    {
      ...webProvider("other-fetch", "webFetch", 100),
      id: "other",
      getConfiguredCredentialFallback: () => ({
        path: "plugins.entries.other-fetch.config.webSearch.apiKey",
        value: undefined,
      }),
    },
  ]),
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: vi.fn(() => [
    {
      ...webProvider("brave", "webSearch", 10),
      getConfiguredCredentialValue: (config?: unknown) =>
        readPath(config, "plugins.entries.brave.config.webSearch.apiKey") ??
        readPath(config, "tools.web.search.apiKey"),
      getCredentialValue: (searchConfig?: { apiKey?: unknown }) => searchConfig?.apiKey,
    },
    {
      ...webProvider("firecrawl", "webSearch", 60),
      getConfiguredCredentialFallback: (config?: unknown) => {
        const apiKey = readPath(config, "plugins.entries.firecrawl.config.webFetch.apiKey");
        return apiKey === undefined
          ? undefined
          : {
              path: "plugins.entries.firecrawl.config.webFetch.apiKey",
              value: apiKey,
            };
      },
    },
    {
      ...webProvider("exa", "webSearch", 65),
      getCredentialValue: (searchConfig?: { exa?: { apiKey?: unknown } }) =>
        searchConfig?.exa?.apiKey,
    },
    {
      ...webProvider("gemini", "webSearch", 20),
      getConfiguredCredentialValue: (): undefined => undefined,
      getConfiguredCredentialFallback: (config?: unknown) => ({
        path: "models.providers.google.apiKey",
        value: readPath(config, "models.providers.google.apiKey"),
      }),
    },
    {
      ...webProvider("ollama", "webSearch", 110),
      credentialPath: "",
      getConfiguredCredentialValue: (): undefined => undefined,
    },
  ]),
}));

import {
  getAgentRuntimeCommandSecretTargetIds,
  getCapabilityWebFetchCommandSecretTargets,
  getCapabilityWebSearchCommandSecretTargets,
  getModelsCommandSecretTargetIds,
  getQrRemoteCommandSecretTargetIds,
  getScopedChannelsCommandSecretTargets,
  getSecurityAuditCommandSecretTargetIds,
  getStatusCommandSecretTargetIds,
} from "./command-secret-targets.js";

function pluginWebKeys(plugin: string, keys: { webFetch?: unknown; webSearch?: unknown }) {
  const config = Object.fromEntries(Object.entries(keys).map(([key, apiKey]) => [key, { apiKey }]));
  return { plugins: { entries: { [plugin]: { config } } } };
}

function firecrawlWebKey(capability: "webFetch" | "webSearch", apiKey: unknown) {
  return pluginWebKeys("firecrawl", { [capability]: apiKey });
}

function secretRef(id: string) {
  return { source: "env", provider: "default", id };
}

function modelKeys(keys: Record<string, unknown>) {
  return {
    models: {
      providers: Object.fromEntries(Object.entries(keys).map(([id, apiKey]) => [id, { apiKey }])),
    },
  };
}

function discordAccounts(accounts: Record<string, string>) {
  return {
    channels: {
      discord: {
        defaultAccount: "Ops Team",
        accounts: Object.fromEntries(
          Object.entries(accounts).map(([id, ref]) => [id, { token: secretRef(ref) }]),
        ),
      },
    },
  };
}

describe("command secret target ids", () => {
  it("keeps static qr remote targets out of the registry path", () => {
    const ids = getQrRemoteCommandSecretTargetIds();
    expect(ids).toEqual(new Set(["gateway.remote.token", "gateway.remote.password"]));
  });

  it("keeps static model targets out of the registry path", () => {
    const ids = getModelsCommandSecretTargetIds();
    expect(ids.has("models.providers.*.apiKey")).toBe(true);
    expect(ids.has("models.providers.*.request.tls.key")).toBe(true);
    expect(ids.has("channels.discord.token")).toBe(false);
  });

  it("includes gateway auth targets for status command scans", () => {
    const ids = getStatusCommandSecretTargetIds({});

    expect(ids.has("gateway.auth.token")).toBe(true);
    expect(ids.has("gateway.auth.password")).toBe(true);
    expect(ids.has("gateway.remote.token")).toBe(true);
    expect(ids.has("gateway.remote.password")).toBe(true);
    expect(ids.has("memory.search.remote.apiKey")).toBe(true);
    expect(ids.has("agents.entries.*.memory.search.remote.apiKey")).toBe(true);
    expect(ids.has("channels.discord.token")).toBe(false);
  });

  it("scopes capability web search commands to search credential surfaces only", () => {
    const { targetIds: ids } = getCapabilityWebSearchCommandSecretTargets({});
    expect(ids.has("plugins.entries.exa.config.webSearch.apiKey")).toBe(true);
    expect(ids.has("plugins.entries.firecrawl.config.webFetch.apiKey")).toBe(false);
    expect(ids.has("plugins.entries.voice-call.config.twilio.authToken")).toBe(false);
    expect(ids.has("models.providers.openai.apiKey")).toBe(false);
    expect(ids.has("memory.search.remote.apiKey")).toBe(false);
    expect(ids.has("tts.providers.openai.apiKey")).toBe(false);
    expect(ids.has("skills.entries.demo.apiKey")).toBe(false);
    expect(ids.has("channels.discord.token")).toBe(false);
  });

  it("discovers explicit search provider targets even when config selects another provider", async () => {
    const webSearchProviders = await import("../plugins/web-search-providers.runtime.js");
    vi.mocked(webSearchProviders.resolvePluginWebSearchProviders).mockImplementationOnce(
      (params: { config?: { tools?: { web?: { search?: { provider?: string } } } } }) => {
        const selectedProvider = params.config?.tools?.web?.search?.provider;
        const id = selectedProvider === "firecrawl" ? "firecrawl" : "exa";
        const credentialPath = `plugins.entries.${id}.config.webSearch.apiKey`;
        return [
          {
            pluginId: id,
            id,
            credentialPath,
            getConfiguredCredentialValue: (config?: unknown) => readPath(config, credentialPath),
            getConfiguredCredentialFallback: (): undefined => undefined,
            getCredentialValue: (): undefined => undefined,
          },
        ] as never;
      },
    );

    const scoped = getCapabilityWebSearchCommandSecretTargets(
      {
        tools: { web: { search: { provider: "exa", enabled: true } } },
        ...firecrawlWebKey("webSearch", secretRef("FIRECRAWL_API_KEY")),
      } as never,
      { providerId: "firecrawl" },
    );

    expect(scoped.targetIds).toEqual(
      new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
    );
    expect(scoped.forcedActivePaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
    );
  });

  it("maps selected fallback credential paths to registry targets", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets({
      tools: { web: { search: { provider: "gemini", enabled: true } } },
      ...modelKeys({ google: secretRef("GOOGLE_API_KEY") }),
    } as never);

    expect(scoped.targetIds).toEqual(
      new Set(["models.providers.*.apiKey", "plugins.entries.gemini.config.webSearch.apiKey"]),
    );
    expect(scoped.allowedPaths).toEqual(
      new Set(["models.providers.google.apiKey", "plugins.entries.gemini.config.webSearch.apiKey"]),
    );
    expect(scoped.forcedActivePaths).toEqual(new Set(["models.providers.google.apiKey"]));
  });

  it("maps selected Ollama web search to its model provider key", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets({
      tools: { web: { search: { provider: "ollama", enabled: true } } },
      ...modelKeys({ ollama: secretRef("OLLAMA_API_KEY") }),
    } as never);

    expect(scoped.targetIds).toEqual(new Set(["models.providers.*.apiKey"]));
    expect(scoped.allowedPaths).toEqual(new Set(["models.providers.ollama.apiKey"]));
    expect(scoped.forcedActivePaths).toEqual(new Set(["models.providers.ollama.apiKey"]));
  });

  it("uses Firecrawl web fetch credentials as search fallback targets", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets({
      tools: { web: { search: { provider: "firecrawl", enabled: true } } },
      ...firecrawlWebKey("webFetch", "firecrawl-key"),
    } as never);

    expect(scoped.targetIds).toEqual(
      new Set([
        "plugins.entries.firecrawl.config.webFetch.apiKey",
        "plugins.entries.firecrawl.config.webSearch.apiKey",
      ]),
    );
    expect(scoped.allowedPaths).toBeUndefined();
    expect(scoped.forcedActivePaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webFetch.apiKey"]),
    );
  });

  it("does not force search fallback refs when web search is disabled", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets({
      tools: { web: { search: { enabled: false, provider: "firecrawl" } } },
      ...firecrawlWebKey("webFetch", secretRef("FIRECRAWL_API_KEY")),
    } as never);

    expect(scoped.targetIds.has("plugins.entries.firecrawl.config.webFetch.apiKey")).toBe(false);
    expect(scoped.allowedPaths).toBeUndefined();
    expect(scoped.forcedActivePaths).toBeUndefined();
  });

  it("limits auto-detect wildcard fallback paths to the concrete configured path", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets({
      tools: { web: { search: { enabled: true } } },
      ...modelKeys({ google: "google-key", openai: secretRef("OPENAI_API_KEY") }),
    } as never);

    expect(scoped.targetIds.has("models.providers.*.apiKey")).toBe(true);
    expect(scoped.allowedPaths).toEqual(new Set(["models.providers.google.apiKey"]));
    expect(scoped.forcedActivePaths).toBeUndefined();
    expect(scoped.optionalActivePaths).toEqual(new Set(["models.providers.google.apiKey"]));
  });

  it("falls back to broad web search command targets for stale configured providers", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets({
      tools: { web: { search: { provider: "stale", enabled: true } } },
      ...pluginWebKeys("exa", { webSearch: secretRef("EXA_API_KEY") }),
    } as never);

    expect(scoped.targetIds).toEqual(
      new Set([
        "plugins.entries.brave.config.webSearch.apiKey",
        "plugins.entries.exa.config.webSearch.apiKey",
        "plugins.entries.firecrawl.config.webSearch.apiKey",
        "plugins.entries.gemini.config.webSearch.apiKey",
        "plugins.entries.other-fetch.config.webSearch.apiKey",
      ]),
    );
    expect(scoped.forcedActivePaths).toBeUndefined();
  });

  it("adds configured fetch fallback credential paths only when the fetch key is absent", () => {
    const fallbackRef = secretRef("FIRECRAWL_API_KEY");
    const fallbackOnly = getCapabilityWebFetchCommandSecretTargets({
      tools: { web: { fetch: { provider: "firecrawl", enabled: true } } },
      ...firecrawlWebKey("webSearch", fallbackRef),
    } as never);

    expect(fallbackOnly.targetIds.has("plugins.entries.firecrawl.config.webSearch.apiKey")).toBe(
      true,
    );
    expect(fallbackOnly.allowedPaths).toBeUndefined();
    expect(fallbackOnly.forcedActivePaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
    );

    const fetchConfigured = getCapabilityWebFetchCommandSecretTargets({
      tools: { web: { fetch: { provider: "firecrawl", enabled: true } } },
      ...pluginWebKeys("firecrawl", {
        webFetch: secretRef("FIRECRAWL_API_KEY"),
        webSearch: fallbackRef,
      }),
    } as never);

    expect(fetchConfigured.targetIds.has("plugins.entries.firecrawl.config.webSearch.apiKey")).toBe(
      false,
    );
    expect(fetchConfigured.allowedPaths).toBeUndefined();
    expect(fetchConfigured.forcedActivePaths).toBeUndefined();
  });

  it("uses an explicit fetch provider override when scoping fallback credential paths", () => {
    const scoped = getCapabilityWebFetchCommandSecretTargets(
      {
        tools: { web: { fetch: { enabled: true } } },
        ...firecrawlWebKey("webSearch", secretRef("FIRECRAWL_API_KEY")),
      } as never,
      { providerId: "firecrawl" },
    );

    expect(scoped.targetIds.has("plugins.entries.firecrawl.config.webSearch.apiKey")).toBe(true);
    expect(scoped.allowedPaths).toBeUndefined();
    expect(scoped.forcedActivePaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
    );
  });

  it("includes channel targets for agent runtime when delivery needs them", () => {
    const ids = getAgentRuntimeCommandSecretTargetIds({ config: {}, includeChannelTargets: true });
    expect(ids.has("channels.discord.token")).toBe(true);
    expect(ids.has("channels.telegram.botToken")).toBe(true);
  });

  it("includes gateway auth and channel targets for security audit", () => {
    const ids = getSecurityAuditCommandSecretTargetIds();
    expect(ids.has("channels.discord.token")).toBe(true);
    expect(ids.has("gateway.auth.token")).toBe(true);
    expect(ids.has("gateway.auth.password")).toBe(true);
    expect(ids.has("gateway.remote.token")).toBe(true);
    expect(ids.has("gateway.remote.password")).toBe(true);
  });

  it("does not coerce missing accountId to default when channel is scoped", () => {
    const scoped = getScopedChannelsCommandSecretTargets({
      config: discordAccounts({ "Ops Team": "DISCORD_OPS" }) as never,
      channel: "discord",
    });

    expect(scoped.allowedPaths).toBeUndefined();
    expect(scoped.targetIds).toEqual(
      new Set(["channels.discord.accounts.*.token", "channels.discord.token"]),
    );
  });

  it("scopes a missing accountId to the channel default when requested", () => {
    const scoped = getScopedChannelsCommandSecretTargets({
      config: discordAccounts({ "Ops Team": "DISCORD_OPS", chat: "DISCORD_CHAT" }) as never,
      channel: "discord",
      defaultAccountWhenMissing: true,
    });

    expect(scoped.allowedPaths).toEqual(new Set(["channels.discord.accounts.Ops Team.token"]));
  });

  it("unions only the selected broadcast channel/account routes", () => {
    const scoped = getScopedChannelsCommandSecretTargets({
      config: {
        channels: {
          discord: {
            token: "discord-default",
            accounts: { ops: { token: "discord-ops" } },
          },
          telegram: { botToken: "telegram-default" },
        },
      } as never,
      channels: ["discord", "telegram"],
      accountId: "ops",
    });

    expect(scoped.allowedPaths?.has("channels.discord.token")).toBe(true);
    expect(scoped.allowedPaths?.has("channels.discord.accounts.ops.token")).toBe(true);
    expect(scoped.allowedPaths?.has("channels.telegram.botToken")).toBe(true);
  });

  it("keeps account-scoped allowedPaths as an empty set when scoped target paths are absent", () => {
    const scoped = getScopedChannelsCommandSecretTargets({
      config: {
        channels: {
          discord: {
            accounts: {
              ops: { enabled: true },
            },
          },
        },
      } as never,
      channel: "custom-plugin-channel-without-secret-targets",
      accountId: "ops",
    });

    expect(scoped.allowedPaths).toEqual(new Set());
  });
});
