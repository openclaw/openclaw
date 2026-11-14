import { describe, expect, it, vi } from "vitest";
import { expandPathTokens, parsePathPattern } from "../secrets/target-registry-pattern.js";

const FETCH_KEY = "plugins.entries.firecrawl.config.webFetch.apiKey";
const SEARCH_KEY = "plugins.entries.firecrawl.config.webSearch.apiKey";
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
  FETCH_KEY,
  SEARCH_KEY,
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
  autoDetectOrder?: number,
) {
  const credentialPath = `plugins.entries.${pluginId}.config.${capability}.apiKey`;
  return {
    pluginId,
    id: pluginId,
    autoDetectOrder,
    credentialPath,
    getConfiguredCredentialValue: (config?: unknown) => readPath(config, credentialPath),
    getConfiguredCredentialFallback: (): undefined => undefined,
  };
}

// mock-isolation: Use the bounded fixture registry instead of discovering real secret targets.
vi.mock("../secrets/target-registry.js", () => ({
  listSecretTargetRegistryEntries: vi.fn(() =>
    REGISTRY_IDS.map((id) => ({
      id,
      pathPattern: id,
    })),
  ),
  discoverConfigSecretTargetsByIds: vi.fn((config: unknown, targetIds?: Iterable<string>) => {
    const allowed = targetIds ? new Set(targetIds) : null;
    return REGISTRY_IDS.filter((id) => !allowed || allowed.has(id)).flatMap((id) =>
      expandPathTokens(config, parsePathPattern(id))
        .filter(({ value }) => value !== undefined)
        .map(({ segments }) => ({
          entry: { id },
          path: segments.join("."),
          pathSegments: segments,
        })),
    );
  }),
}));

// mock-isolation: Resolve fixture credentials without loading provider plugins or operator state.
vi.mock("../plugins/web-fetch-providers.runtime.js", () => ({
  resolvePluginWebFetchProviders: vi.fn((params: { config?: Record<string, unknown> }) => [
    {
      ...webProvider("firecrawl", "webFetch", 50),
      getConfiguredCredentialFallback: () => ({
        path: SEARCH_KEY,
        value: readPath(params.config, SEARCH_KEY),
      }),
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

// mock-isolation: Resolve fixture credentials without loading provider plugins or operator state.
vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: vi.fn(() => [
    {
      ...webProvider("brave", "webSearch", 10),
      getConfiguredCredentialValue: (config?: unknown) =>
        readPath(config, "plugins.entries.brave.config.webSearch.apiKey") ??
        readPath(config, "tools.web.search.apiKey"),
    },
    {
      ...webProvider("firecrawl", "webSearch", 60),
      getConfiguredCredentialFallback: (config?: unknown) => {
        const apiKey = readPath(config, FETCH_KEY);
        return apiKey === undefined
          ? undefined
          : {
              path: FETCH_KEY,
              value: apiKey,
            };
      },
    },
    webProvider("exa", "webSearch", 65),
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

function webConfig(provider: string | undefined, credentials: object, enabled = true) {
  return { tools: { web: { search: { provider, enabled } } }, ...credentials };
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

type Scope = ReturnType<typeof getCapabilityWebSearchCommandSecretTargets>;
function expectScope(scope: Scope, expected: Partial<Record<keyof Scope, string[] | undefined>>) {
  for (const key of [
    "targetIds",
    "allowedPaths",
    "forcedActivePaths",
    "optionalActivePaths",
  ] as const) {
    if (key in expected) {
      const paths = expected[key];
      expect(scope[key], key).toEqual(paths === undefined ? undefined : new Set(paths));
    }
  }
}

describe("command secret target ids", () => {
  it("keeps static qr remote targets out of the registry path", () => {
    expect(getQrRemoteCommandSecretTargetIds()).toEqual(
      new Set(["gateway.remote.token", "gateway.remote.password"]),
    );
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
    expect(ids.has(FETCH_KEY)).toBe(false);
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
        return [webProvider(id, "webSearch")] as never;
      },
    );

    const scoped = getCapabilityWebSearchCommandSecretTargets(
      webConfig("exa", firecrawlWebKey("webSearch", secretRef("FIRECRAWL_API_KEY"))) as never,
      { providerId: "firecrawl" },
    );

    expectScope(scoped, {
      targetIds: [SEARCH_KEY],
      forcedActivePaths: [SEARCH_KEY],
    });
  });

  it.each([
    {
      provider: "gemini",
      model: "google",
      pluginPath: "plugins.entries.gemini.config.webSearch.apiKey",
    },
    { provider: "ollama", model: "ollama", pluginPath: undefined },
  ])(
    "maps selected $provider search to its model provider key",
    ({ provider, model, pluginPath }) => {
      const scoped = getCapabilityWebSearchCommandSecretTargets(
        webConfig(
          provider,
          modelKeys({ [model]: secretRef(`${model.toUpperCase()}_API_KEY`) }),
        ) as never,
      );
      const pluginPaths = pluginPath ? [pluginPath] : [];
      const modelPath = `models.providers.${model}.apiKey`;
      expectScope(scoped, {
        targetIds: ["models.providers.*.apiKey", ...pluginPaths],
        allowedPaths: [modelPath, ...pluginPaths],
        forcedActivePaths: [modelPath],
      });
    },
  );

  it.each([
    [true, "firecrawl-key"],
    [false, secretRef("FIRECRAWL_API_KEY")],
  ] as const)("scopes Firecrawl search fallback (enabled=%s)", (enabled, apiKey) => {
    const scoped = getCapabilityWebSearchCommandSecretTargets(
      webConfig("firecrawl", firecrawlWebKey("webFetch", apiKey), enabled) as never,
    );
    expect(scoped.targetIds.has(FETCH_KEY)).toBe(enabled);
    expectScope(scoped, {
      ...(enabled ? { targetIds: [FETCH_KEY, SEARCH_KEY] } : {}),
      allowedPaths: undefined,
      forcedActivePaths: enabled ? [FETCH_KEY] : undefined,
    });
  });

  it("limits auto-detect wildcard fallback paths to the concrete configured path", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets(
      webConfig(
        undefined,
        modelKeys({ google: "google-key", openai: secretRef("OPENAI_API_KEY") }),
      ) as never,
    );

    expect(scoped.targetIds.has("models.providers.*.apiKey")).toBe(true);
    expectScope(scoped, {
      allowedPaths: ["models.providers.google.apiKey"],
      forcedActivePaths: undefined,
      optionalActivePaths: ["models.providers.google.apiKey"],
    });
  });

  it("falls back to broad web search command targets for stale configured providers", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets(
      webConfig("stale", pluginWebKeys("exa", { webSearch: secretRef("EXA_API_KEY") })) as never,
    );

    expectScope(scoped, {
      targetIds: [
        "plugins.entries.brave.config.webSearch.apiKey",
        "plugins.entries.exa.config.webSearch.apiKey",
        SEARCH_KEY,
        "plugins.entries.gemini.config.webSearch.apiKey",
        "plugins.entries.other-fetch.config.webSearch.apiKey",
      ],
      forcedActivePaths: undefined,
    });
  });

  it.each([true, false])(
    "uses fetch fallback credentials only when the fetch key is absent: %s",
    (missing) => {
      const scoped = getCapabilityWebFetchCommandSecretTargets({
        tools: { web: { fetch: { provider: "firecrawl", enabled: true } } },
        ...pluginWebKeys("firecrawl", {
          webFetch: missing ? undefined : secretRef("FIRECRAWL_API_KEY"),
          webSearch: secretRef("FIRECRAWL_API_KEY"),
        }),
      } as never);
      expect(scoped.targetIds.has(SEARCH_KEY)).toBe(missing);
      expectScope(scoped, {
        allowedPaths: undefined,
        forcedActivePaths: missing ? [SEARCH_KEY] : undefined,
      });
    },
  );

  it("uses an explicit fetch provider override when scoping fallback credential paths", () => {
    const scoped = getCapabilityWebFetchCommandSecretTargets(
      {
        tools: { web: { fetch: { enabled: true } } },
        ...firecrawlWebKey("webSearch", secretRef("FIRECRAWL_API_KEY")),
      } as never,
      { providerId: "firecrawl" },
    );

    expect(scoped.targetIds.has(SEARCH_KEY)).toBe(true);
    expectScope(scoped, {
      allowedPaths: undefined,
      forcedActivePaths: [SEARCH_KEY],
    });
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

  it.each([false, true])(
    "uses a default channel account only when requested (%s)",
    (defaultAccountWhenMissing) => {
      const scoped = getScopedChannelsCommandSecretTargets({
        config: discordAccounts({ "Ops Team": "DISCORD_OPS", chat: "DISCORD_CHAT" }) as never,
        channel: "discord",
        defaultAccountWhenMissing,
      });
      expectScope(scoped, {
        targetIds: ["channels.discord.accounts.*.token", "channels.discord.token"],
        allowedPaths: defaultAccountWhenMissing
          ? ["channels.discord.accounts.Ops Team.token"]
          : undefined,
      });
    },
  );

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
      config: { channels: { discord: { accounts: { ops: { enabled: true } } } } } as never,
      channel: "custom-plugin-channel-without-secret-targets",
      accountId: "ops",
    });

    expect(scoped.allowedPaths).toEqual(new Set());
  });
});
