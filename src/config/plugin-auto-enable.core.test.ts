// Covers core plugin auto-enable behavior and bundled plugin defaults.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import { initializeNativeSessionCatalogPreferences } from "../plugins/native-session-catalog-config.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  applyPluginAutoEnable,
  detectPluginAutoEnableCandidates,
  materializePluginAutoEnableCandidates,
} from "./plugin-auto-enable.js";
import {
  createPluginMetadataSnapshot,
  makeBundledChannelCandidate,
  makeIsolatedEnv,
  makeRegistry,
  resetPluginAutoEnableTestState,
} from "./plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { validateConfigObject } from "./validation.js";

vi.mock("../channels/plugins/package-state-probes.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../channels/plugins/package-state-probes.js")>();
  return {
    ...actual,
    listBundledChannelIdsForPackageState: (
      ...args: Parameters<typeof actual.listBundledChannelIdsForPackageState>
    ) => {
      const channelIds = actual.listBundledChannelIdsForPackageState(...args);
      // Declare the synthetic checker; discovery still controls its candidacy.
      return args[0] === "configuredState" ? [...channelIds, "cache-channel"] : channelIds;
    },
    hasBundledChannelPackageState: (
      params: Parameters<typeof actual.hasBundledChannelPackageState>[0],
    ) => {
      if (params.metadataKey !== "configuredState") {
        return actual.hasBundledChannelPackageState(params);
      }
      if (params.channelId === "cache-channel") {
        return Boolean(params.env?.CACHE_CHANNEL_TOKEN?.trim());
      }
      if (params.channelId === "irc") {
        return Boolean(params.env?.IRC_HOST?.trim() && params.env?.IRC_NICK?.trim());
      }
      if (params.channelId === "slack") {
        return ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "SLACK_USER_TOKEN"].some((key) =>
          Boolean(params.env?.[key]?.trim()),
        );
      }
      return actual.hasBundledChannelPackageState(params);
    },
  };
});

const setupRegistryMock = vi.hoisted(() => ({
  resolvePluginSetupAutoEnableReasons: vi.fn(
    (params: { config?: OpenClawConfig; pluginIds?: readonly string[] }) => {
      const pluginIds = new Set(params.pluginIds ?? []);
      const browserEntry = params.config?.plugins?.entries?.browser;
      const hasBrowserEntry =
        browserEntry && typeof browserEntry === "object" && browserEntry.enabled !== false;
      return pluginIds.has("browser") && hasBrowserEntry
        ? [{ pluginId: "browser", reason: "browser plugin configured" }]
        : [];
    },
  ),
}));

vi.mock("../plugins/setup-registry.js", () => ({
  clearPluginSetupRegistryCache: vi.fn(),
  resolvePluginSetupAutoEnableReasons: setupRegistryMock.resolvePluginSetupAutoEnableReasons,
}));

const env = makeIsolatedEnv();
const emptyDiscovery: PluginDiscoveryResult = { candidates: [], diagnostics: [] };
const codexManifestResult = loadPluginManifest(path.join(process.cwd(), "extensions", "codex"));
if (!codexManifestResult.ok) {
  throw new Error(codexManifestResult.error);
}
const codexManifest = codexManifestResult.manifest;
const nativeCatalogRegistry = makeRegistry([
  {
    id: codexManifest.id,
    channels: [],
    origin: "bundled",
    contracts: codexManifest.contracts,
    configSchema: codexManifest.configSchema,
  },
]);

afterAll(() => {
  resetPluginAutoEnableTestState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applyPluginAutoEnable core", () => {
  it("keeps first-write catalog opt-outs inactive under a restrictive allowlist", () => {
    const config = initializeNativeSessionCatalogPreferences({ plugins: { allow: ["existing"] } });
    const result = applyPluginAutoEnable({ config, env, manifestRegistry: nativeCatalogRegistry });
    expect(result.config).toEqual(config);
    expect(result.changes).toEqual([]);
  });

  it("retains explicit plugin selection alongside a first-write catalog opt-out", () => {
    const config = initializeNativeSessionCatalogPreferences({
      plugins: { allow: ["existing"], entries: { codex: { enabled: true } } },
    });
    const result = applyPluginAutoEnable({
      config,
      env,
      manifestRegistry: nativeCatalogRegistry,
    });
    expect(result.config.plugins?.allow).toEqual(["existing", "codex"]);
    expect(result.config.plugins?.entries).toEqual(config.plugins?.entries);
  });

  it("retains authored tool config alongside a first-write catalog opt-out", () => {
    const config = initializeNativeSessionCatalogPreferences({
      plugins: {
        allow: ["existing"],
        entries: { codex: { config: { codexDynamicToolsLoading: "direct" } } },
      },
    });
    const result = applyPluginAutoEnable({ config, env, manifestRegistry: nativeCatalogRegistry });
    expect(result.config.plugins?.allow).toEqual(["existing", "codex"]);
    expect(result.config.plugins?.entries?.codex).toEqual({
      ...config.plugins?.entries?.codex,
      enabled: true,
    });
    expect(result.changes).toEqual(["codex tool configured, enabled automatically."]);
  });

  it.each([
    { name: "unchanged defaults", snapshotPaths: [], runtimePaths: [], reuse: true },
    {
      name: "new custom paths",
      snapshotPaths: [],
      runtimePaths: ["/tmp/changed-plugin-root"],
      reuse: false,
    },
    {
      name: "custom paths reset to defaults",
      snapshotPaths: ["/tmp/custom-plugin-root"],
      runtimePaths: [],
      reuse: false,
    },
  ])(
    "reuses current metadata only with compatible load paths ($name)",
    ({ snapshotPaths, runtimePaths, reuse }) => {
      const manifestRegistry = makeRegistry([{ id: "custom-chat", channels: ["custom-chat"] }]);
      const snapshotConfig: OpenClawConfig = {
        plugins: {
          allow: ["existing"],
          ...(snapshotPaths.length ? { load: { paths: snapshotPaths } } : {}),
        },
      };
      const scope = { config: snapshotConfig, env, workspaceDir: "/tmp/workspace" };
      setCurrentPluginMetadataSnapshot(
        createPluginMetadataSnapshot({ ...scope, manifestRegistry }),
        scope,
      );
      const result = applyPluginAutoEnable({
        config: {
          plugins: {
            allow: ["existing"],
            ...(runtimePaths.length ? { load: { paths: runtimePaths } } : {}),
            entries: { "custom-chat": { config: { token: "x" } } },
          },
        },
        env,
      });
      expect(result.config.plugins?.allow).toEqual(
        reuse ? ["existing", "custom-chat"] : ["existing"],
      );
      expect(result.changes).toEqual(
        reuse ? ["custom-chat plugin config present, added to plugin allowlist."] : [],
      );
    },
  );

  it.each([
    ["TTS", { tts: { provider: "gradium" } }, "gradium", "gradium", "speechProviders"],
    [
      "sole Talk speech alias",
      { talk: { providers: { "gradium-voice": {} } } },
      "gradium-voice",
      "gradium",
      "speechProviders",
    ],
    [
      "Talk realtime alias",
      { talk: { realtime: { provider: "grok-voice", providers: { "grok-voice": {} } } } },
      "grok-voice",
      "xai",
      "realtimeVoiceProviders",
    ],
  ] as const)(
    "auto-enables the manifest owner selected by %s",
    (_surface, config, id, owner, key) => {
      const result = applyPluginAutoEnable({
        config: {
          ...config,
          plugins: { allow: ["telegram"] },
        },
        env,
        manifestRegistry: makeRegistry([
          { id: owner, channels: [], contracts: { [key]: [owner, id] }, origin: "global" },
        ]),
      });

      const reason = `${id} ${key === "speechProviders" ? "speech" : "realtime voice"} provider selected`;
      expect(result.config.plugins?.allow).toEqual(["telegram", owner]);
      expect(result.config.plugins?.entries?.[owner]).toEqual({ enabled: true });
      expect(result.autoEnabledReasons).toEqual({ [owner]: [reason] });
      expect(result.changes).toContain(`${reason}, enabled automatically.`);
    },
  );

  it.each([
    { name: "an undefined config", config: undefined, envOverrides: {} },
    {
      name: "unrelated Slack-prefixed environment variables",
      config: {},
      envOverrides: { SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T000/B000/XXX" },
    },
  ])("keeps plugin auto-enable inactive with $name", ({ config, envOverrides }) => {
    const result = applyPluginAutoEnable({
      config,
      env: makeIsolatedEnv(envOverrides),
    });

    expect(result.config).toStrictEqual({});
    expect(result.changes).toStrictEqual([]);
    expect(result.autoEnabledReasons).toStrictEqual({});
  });

  it("auto-enables built-in channels and preserves them in restrictive plugins.allow", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { allow: ["telegram"] },
      },
      env,
    });

    expect(result.config.channels?.slack?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.slack).toBeUndefined();
    expect(result.config.plugins?.allow).toEqual(["telegram", "slack"]);
    expect(result.autoEnabledReasons).toEqual({
      slack: ["slack configured"],
    });
    expect(Object.getPrototypeOf(result.autoEnabledReasons)).toBeNull();
    expect(result.changes.join("\n")).toContain("Slack configured, enabled automatically.");
  });

  it("preserves an empty plugins.allow as nonrestrictive during auto-enable", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { allow: [] },
      },
      env,
    });

    expect(result.config.channels?.slack?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual([]);
    expect(result.changes.join("\n")).toContain("Slack configured, enabled automatically.");
  });

  it.each<OpenClawConfig>([{ browser: { enabled: false } }, { tools: { allow: ["browser"] } }])(
    "does not load disabled browser plugin manifests with setup input %j",
    (setup) => {
      const readFileSync = vi.spyOn(fs, "readFileSync");
      const result = applyPluginAutoEnable({
        config: {
          ...setup,
          plugins: { allow: ["telegram"], entries: { browser: { enabled: false } } },
        },
        env,
      });
      expect(result.config.plugins?.allow).toEqual(["telegram"]);
      expect(result.config.plugins?.entries?.browser?.enabled).toBe(false);
      expect(result.changes).toStrictEqual([]);
      expect(
        readFileSync.mock.calls.some(
          ([filePath]) => typeof filePath === "string" && filePath.endsWith("openclaw.plugin.json"),
        ),
      ).toBe(false);
    },
  );

  it("does not auto-enable or allowlist non-bundled web fetch providers from config", () => {
    const result = applyPluginAutoEnable({
      config: {
        tools: { web: { fetch: { provider: "evilfetch" } } },
        plugins: { allow: ["telegram"] },
      },
      env,
      manifestRegistry: makeRegistry([
        {
          id: "evil-plugin",
          channels: [],
          contracts: { webFetchProviders: ["evilfetch"] },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.["evil-plugin"]).toBeUndefined();
    expect(result.config.plugins?.allow).toEqual(["telegram"]);
    expect(result.changes).toStrictEqual([]);
  });

  it("auto-enables bundled firecrawl when plugin-owned webFetch config exists", () => {
    const result = applyPluginAutoEnable({
      config: {
        plugins: {
          allow: ["telegram"],
          entries: { firecrawl: { config: { webFetch: { apiKey: "firecrawl-key" } } } },
        },
      },
      env,
    });

    expect(result.config.plugins?.entries?.firecrawl?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["telegram", "firecrawl"]);
    expect(result.changes).toContain("firecrawl web fetch configured, enabled automatically.");
  });

  it("bounds repeated model-candidate preference checks without changing plugin precedence", () => {
    let denyChecks = 0;
    const deny = new Proxy(["blocked"], {
      get(target, property, receiver) {
        if (property === "includes") {
          return (pluginId: string) => {
            denyChecks += 1;
            return target.includes(pluginId);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: Object.fromEntries(
          Array.from({ length: 128 }, (_, index) => [
            `agent-${index}`,
            {
              model: {
                primary: `secondary/model-${index}`,
                fallbacks: [`primary/model-${index}`, `blocked/model-${index}`],
              },
            },
          ]),
        ),
      },
      plugins: { deny },
    };
    expect(validateConfigObject(config).ok).toBe(true);
    denyChecks = 0;

    const result = applyPluginAutoEnable({
      config,
      env,
      manifestRegistry: makeRegistry([
        { id: "primary", channels: [], providers: ["primary"] },
        {
          id: "secondary",
          channels: [],
          providers: ["secondary"],
          channelConfigs: { secondary: { schema: {}, preferOver: ["primary"] } },
        },
        {
          id: "blocked",
          channels: [],
          providers: ["blocked"],
          channelConfigs: { blocked: { schema: {}, preferOver: ["secondary"] } },
        },
      ]),
    });

    expect(denyChecks).toBeLessThanOrEqual(6);
    expect(result.config.plugins?.entries?.primary?.enabled).toBe(false);
    expect(result.config.plugins?.entries?.secondary?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.blocked).toBeUndefined();
    expect(result.changes).toEqual(["secondary/model-0 model configured, enabled automatically."]);
    expect(result.autoEnabledReasons.secondary).toEqual(["secondary/model-0 model configured"]);
  });

  it.each([
    { name: "OpenClaw preference", runtime: "openclaw", api: undefined, codexEnabled: false },
    {
      name: "implicit subscription route with legacy Completions",
      runtime: undefined,
      api: "openai-completions",
      codexEnabled: true,
    },
  ] as const)("preserves $name for auth-profile models", ({ runtime, api, codexEnabled }) => {
    const config: OpenClawConfig = {
      auth: { profiles: { "openai:work": { provider: "openai", mode: "oauth" } } },
      ...(api
        ? {
            models: {
              providers: { openai: { api, baseUrl: "https://api.openai.com/v1", models: [] } },
            },
          }
        : {}),
      agents: {
        entries: {
          main: {
            model: "openai/gpt-5.6-sol@openai:work",
            models: { "openai/gpt-5.6-sol": runtime ? { agentRuntime: { id: runtime } } : {} },
          },
        },
      },
      plugins: {
        allow: ["openai"],
        entries: { openai: { enabled: true } },
      },
    };
    const result = applyPluginAutoEnable({
      config,
      env,
      manifestRegistry: makeRegistry([
        { id: "openai", channels: [], providers: ["openai"] },
        {
          id: "codex",
          channels: [],
          activation: { onAgentHarnesses: ["codex"] },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.codex?.enabled).toBe(codexEnabled ? true : undefined);
    expect(result.config.plugins?.allow).toEqual(codexEnabled ? ["openai", "codex"] : ["openai"]);
    expect(result.config.agents).toEqual(config.agents);
    expect(result.config.auth).toEqual(config.auth);
  });

  it("auto-enables a CLI backend owner when a provider runtime is configured", () => {
    const result = applyPluginAutoEnable({
      config: {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              models: [],
              agentRuntime: { id: "claude-cli" },
            },
          },
        },
        plugins: { allow: ["telegram"] },
      },
      env,
      manifestRegistry: makeRegistry([
        {
          id: "anthropic",
          channels: [],
          providers: ["anthropic"],
          cliBackends: ["claude-cli"],
        },
      ]),
    });

    expect(result.config.plugins?.entries?.anthropic?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["telegram", "anthropic"]);
    expect(result.changes).toContain("claude-cli agent runtime configured, enabled automatically.");
  });

  it("ignores channels.modelByChannel for plugin auto-enable", () => {
    const result = applyPluginAutoEnable({
      config: { channels: { modelByChannel: { openai: { whatsapp: "openai/gpt-5.4" } } } },
      env,
    });

    expect(result.config.plugins?.entries?.modelByChannel).toBeUndefined();
    expect(result.config.plugins?.allow).toBeUndefined();
    expect(result.changes).toStrictEqual([]);
  });

  it("does not auto-enable WhatsApp from persisted auth state alone", () => {
    const persistedEnv = makeIsolatedEnv();
    const authDir = path.join(
      persistedEnv.OPENCLAW_STATE_DIR ?? "",
      "credentials",
      "whatsapp",
      "default",
    );
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, "creds.json"), "{}", "utf-8");

    const candidates = detectPluginAutoEnableCandidates({
      config: {},
      env: persistedEnv,
    });
    const result = applyPluginAutoEnable({
      config: {},
      env: persistedEnv,
    });

    expect(candidates).toStrictEqual([]);
    expect(result.config).toStrictEqual({});
    expect(result.changes).toStrictEqual([]);
  });

  it("preserves official external plugin entries before installation", () => {
    const result = materializePluginAutoEnableCandidates({
      config: {
        plugins: {
          allow: ["glueclaw"],
          entries: { codex: { enabled: true } },
        },
      },
      candidates: [],
      env,
      manifestRegistry: makeRegistry([]),
    });

    expect(result.config.plugins?.allow).toEqual(["glueclaw", "codex"]);
    expect(result.changes).toContain("codex plugin config present, added to plugin allowlist.");
  });

  it("does not preserve stale configured plugin entries in restrictive plugins.allow", () => {
    const result = materializePluginAutoEnableCandidates({
      config: {
        plugins: {
          allow: ["glueclaw"],
          entries: { "missing-plugin": { config: { token: "x" } } },
        },
      },
      candidates: [],
      env,
      manifestRegistry: makeRegistry([]),
    });

    expect(result.config.plugins?.allow).toEqual(["glueclaw"]);
    expect(result.changes).toStrictEqual([]);
  });

  it("does not re-emit built-in auto-enable changes when rerun with plugins.allow set", () => {
    const first = applyPluginAutoEnable({
      config: {
        channels: { whatsapp: { allowFrom: ["+15555550123"] } },
        plugins: { allow: ["telegram"] },
      },
      env,
    });

    const second = applyPluginAutoEnable({
      config: first.config,
      env,
    });

    expect(first.config.channels?.whatsapp?.enabled).toBe(true);
    expect(first.config.plugins?.allow).toEqual(["telegram", "whatsapp"]);
    expect(validateConfigObject(first.config).ok).toBe(true);
    expect(first.changes).toHaveLength(1);
    expect(second.changes).toStrictEqual([]);
    expect(second.config).toEqual(first.config);
  });

  it("reuses same-turn auto-enable results for identical fanout inputs", async () => {
    setupRegistryMock.resolvePluginSetupAutoEnableReasons.mockClear();
    const manifestRegistry = makeRegistry([{ id: "browser", channels: [] }]);
    const config: OpenClawConfig = {
      plugins: { entries: { browser: { config: {} } } },
    };

    const first = applyPluginAutoEnable({
      config,
      discovery: emptyDiscovery,
      env,
      manifestRegistry,
    });
    const second = applyPluginAutoEnable({
      config,
      discovery: emptyDiscovery,
      env,
      manifestRegistry,
    });

    expect(second).toBe(first);
    expect(setupRegistryMock.resolvePluginSetupAutoEnableReasons).toHaveBeenCalledTimes(1);

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const third = applyPluginAutoEnable({
      config,
      discovery: emptyDiscovery,
      env,
      manifestRegistry,
    });

    expect(third).not.toBe(first);
    expect(third).toEqual(first);
    expect(setupRegistryMock.resolvePluginSetupAutoEnableReasons).toHaveBeenCalledTimes(2);
  });

  it("fingerprints identical metadata snapshots once per plugin metadata lifecycle", () => {
    const traversals = { candidates: 0, plugins: 0 };
    const config: OpenClawConfig = {};
    const envSnapshot = makeIsolatedEnv();
    const discovery: PluginDiscoveryResult = {
      candidates: new Proxy([], {
        get: (target, property, receiver) => {
          if (property === "map") {
            traversals.candidates += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      }),
      diagnostics: [],
    };
    const manifestRegistry = makeRegistry([]);
    manifestRegistry.plugins = new Proxy(manifestRegistry.plugins, {
      get: (target, property, receiver) => {
        if (property === "map") {
          traversals.plugins += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const first = applyPluginAutoEnable({
      config,
      discovery,
      env: envSnapshot,
      manifestRegistry,
    });
    const firstTraversalCounts = { ...traversals };

    for (let index = 0; index < 20; index += 1) {
      expect(applyPluginAutoEnable({ config, discovery, env: envSnapshot, manifestRegistry })).toBe(
        first,
      );
    }
    expect(traversals).toEqual(firstTraversalCounts);

    clearPluginMetadataLifecycleCaches();
    applyPluginAutoEnable({ config, discovery, env: envSnapshot, manifestRegistry });

    expect(traversals.candidates).toBeGreaterThan(firstTraversalCounts.candidates);
    expect(traversals.plugins).toBeGreaterThan(firstTraversalCounts.plugins);
  });

  it("does not reuse same-turn results for omitted metadata after current snapshot replacement", () => {
    const config: OpenClawConfig = {
      channels: { apn: { someKey: "value" } },
    };
    const firstRegistry = makeRegistry([{ id: "apn-one", channels: ["apn"] }]);
    const secondRegistry = makeRegistry([{ id: "apn-two", channels: ["apn"] }]);
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshot({ config, manifestRegistry: firstRegistry }),
      { config, env },
    );

    const first = applyPluginAutoEnable({ config, env });
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshot({ config, manifestRegistry: secondRegistry }),
      { config, env },
    );
    const second = applyPluginAutoEnable({ config, env });

    expect(first.config.plugins?.entries?.["apn-one"]?.enabled).toBe(true);
    expect(second.config.plugins?.entries?.["apn-two"]?.enabled).toBe(true);
    expect(second.config.plugins?.entries?.["apn-one"]).toBeUndefined();
    expect(second).not.toBe(first);
  });

  it("refreshes auto-enable results after discovery mutates at a lifecycle boundary", () => {
    const config: OpenClawConfig = {};
    const mutableDiscovery: PluginDiscoveryResult = { candidates: [], diagnostics: [] };
    const manifestRegistry = makeRegistry([
      { id: "cache-channel-plugin", channels: ["cache-channel"] },
    ]);
    const configuredEnv = makeIsolatedEnv({
      CACHE_CHANNEL_TOKEN: "configured",
    });

    const first = applyPluginAutoEnable({
      config,
      discovery: mutableDiscovery,
      env: configuredEnv,
      manifestRegistry,
    });
    mutableDiscovery.candidates.push(
      makeBundledChannelCandidate({
        pluginId: "cache-channel-plugin",
        channelId: "cache-channel",
      }),
    );
    clearPluginMetadataLifecycleCaches();
    const second = applyPluginAutoEnable({
      config,
      discovery: mutableDiscovery,
      env: configuredEnv,
      manifestRegistry,
    });

    expect(first.config.plugins?.entries?.["cache-channel-plugin"]).toBeUndefined();
    expect(second.config.plugins?.entries?.["cache-channel-plugin"]?.enabled).toBe(true);
    expect(second).not.toBe(first);
  });

  it("respects explicit disable", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { entries: { slack: { enabled: false, config: {} } } },
      },
      env,
    });

    expect(result.config.plugins?.entries?.slack?.enabled).toBe(false);
    expect(result.changes).toStrictEqual([]);
  });

  it("respects built-in channel explicit disable via channels.<id>.enabled", () => {
    const result = applyPluginAutoEnable({
      config: { channels: { slack: { botToken: "x", enabled: false } } },
      env,
    });

    expect(result.config.channels?.slack?.enabled).toBe(false);
    expect(result.config.plugins?.entries?.slack).toBeUndefined();
    expect(result.changes).toStrictEqual([]);
  });

  it("does not auto-enable plugin channels when only enabled=false is set", () => {
    const result = applyPluginAutoEnable({
      config: { channels: { matrix: { enabled: false } } },
      env,
      manifestRegistry: makeRegistry([{ id: "matrix", channels: ["matrix"] }]),
    });

    expect(result.config.plugins?.entries?.matrix).toBeUndefined();
    expect(result.changes).toStrictEqual([]);
  });

  it("skips when plugins are globally disabled", () => {
    expect(
      detectPluginAutoEnableCandidates({
        config: {
          channels: { slack: { botToken: "x" } },
          plugins: {
            enabled: false,
            allow: ["slack"],
            entries: { slack: { config: { botToken: "x" } } },
          },
        },
        env,
        manifestRegistry: makeRegistry([{ id: "slack", channels: ["slack"] }]),
      }),
    ).toStrictEqual([]);

    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { enabled: false },
      },
      env,
    });

    expect(result.config.plugins?.entries?.slack?.enabled).toBeUndefined();
    expect(result.changes).toStrictEqual([]);
  });
});
