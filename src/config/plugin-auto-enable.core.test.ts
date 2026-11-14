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
  materializePluginAutoEnableCandidates,
} from "./plugin-auto-enable.js";
import {
  createPluginMetadataSnapshot,
  makeBundledChannelCandidate,
  makeIsolatedEnv,
  makeRegistry,
  resetPluginAutoEnableTestState,
} from "./plugin-auto-enable.test-helpers.js";
import {
  createConfigResolutionFacts,
  getConfigResolutionFacts,
  hasUnresolvedConfigPath,
  setConfigResolutionFacts,
} from "./resolution-facts.js";
import type { ModelProviderConfig } from "./types.models.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import type { PluginEntryConfig } from "./types.plugins.js";
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

// mock-isolation: Auto-enable fixtures control setup probes without executing discovered plugin modules.
vi.mock("../plugins/setup-registry.js", () => ({
  clearPluginSetupRegistryCache: vi.fn(),
  resolvePluginSetupAutoEnableReasons: setupRegistryMock.resolvePluginSetupAutoEnableReasons,
}));

const env = makeIsolatedEnv();
type ManifestPlugin = Parameters<typeof makeRegistry>[0][number];
const plugin = (
  id: string,
  options: Omit<ManifestPlugin, "id" | "channels"> = {},
): ManifestPlugin => ({
  id,
  channels: [],
  ...options,
});
function pluginConfig(id: string, entry: PluginEntryConfig, allow?: string[]): OpenClawConfig {
  return { plugins: { entries: { [id]: entry }, ...(allow ? { allow } : {}) } };
}
function autoEnable(config: OpenClawConfig, plugins?: Parameters<typeof makeRegistry>[0]) {
  return applyPluginAutoEnable({
    config,
    env,
    ...(plugins ? { manifestRegistry: makeRegistry(plugins) } : {}),
  });
}
function slackConfig(plugins: OpenClawConfig["plugins"]): OpenClawConfig {
  return { channels: { slack: { botToken: "x" } }, plugins };
}
function modelConfig(
  id: string,
  baseUrl: string,
  options: Partial<ModelProviderConfig>,
): OpenClawConfig {
  return { models: { providers: { [id]: { baseUrl, models: [], ...options } } } };
}
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

afterAll(() => resetPluginAutoEnableTestState());
afterEach(() => vi.restoreAllMocks());

describe("applyPluginAutoEnable core", () => {
  it("keeps first-write catalog opt-outs inactive under a restrictive allowlist", () => {
    const config = initializeNativeSessionCatalogPreferences({ plugins: { allow: ["existing"] } });
    const result = applyPluginAutoEnable({ config, env, manifestRegistry: nativeCatalogRegistry });
    expect(result.config).toEqual(config);
    expect(result.changes).toEqual([]);
  });

  it.each([
    { name: "explicit selection", entry: { enabled: true } },
    { name: "authored tool config", entry: { config: { codexDynamicToolsLoading: "direct" } } },
  ])("retains $name alongside a first-write catalog opt-out", ({ entry }) => {
    const config = initializeNativeSessionCatalogPreferences(
      pluginConfig("codex", entry, ["existing"]),
    );
    const result = applyPluginAutoEnable({ config, env, manifestRegistry: nativeCatalogRegistry });
    expect(result.config.plugins?.allow).toEqual(["existing", "codex"]);
    if (entry.enabled) {
      expect(result.config.plugins?.entries).toEqual(config.plugins?.entries);
    } else {
      expect(result.config.plugins?.entries?.codex).toEqual({
        ...config.plugins?.entries?.codex,
        enabled: true,
      });
      expect(result.changes).toEqual(["codex tool configured, enabled automatically."]);
    }
  });

  it.each([
    [[], [], true],
    [[], ["/tmp/changed-plugin-root"], false],
    [["/tmp/custom-plugin-root"], [], false],
  ] as const)(
    "reuses current metadata only with compatible load paths: %j -> %j",
    (snapshotPaths, runtimePaths, reuse) => {
      const withPaths = (paths: readonly string[]): OpenClawConfig => ({
        plugins: {
          allow: ["existing"],
          ...(paths.length ? { load: { paths: [...paths] } } : {}),
        },
      });
      const manifestRegistry = makeRegistry([{ id: "custom-chat", channels: ["custom-chat"] }]);
      const snapshotConfig = withPaths(snapshotPaths);
      const scope = { config: snapshotConfig, env, workspaceDir: "/tmp/workspace" };
      setCurrentPluginMetadataSnapshot(
        createPluginMetadataSnapshot({ ...scope, manifestRegistry }),
        scope,
      );
      const result = autoEnable({
        plugins: {
          ...withPaths(runtimePaths).plugins,
          entries: { "custom-chat": { config: { token: "x" } } },
        },
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
      const result = autoEnable({ ...config, plugins: { allow: ["telegram"] } }, [
        plugin(owner, { contracts: { [key]: [owner, id] }, origin: "global" }),
      ]);

      const reason = `${id} ${key === "speechProviders" ? "speech" : "realtime voice"} provider selected`;
      expect(result.config.plugins?.allow).toEqual(["telegram", owner]);
      expect(result.config.plugins?.entries?.[owner]).toEqual({ enabled: true });
      expect(result.autoEnabledReasons).toEqual({ [owner]: [reason] });
      expect(result.changes).toContain(`${reason}, enabled automatically.`);
    },
  );

  it.each<[string, OpenClawConfig?, ManifestPlugin[]?, NodeJS.ProcessEnv?]>([
    ["undefined config"],
    [
      "unrelated Slack environment",
      {},
      undefined,
      { SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T000/B000/XXX" },
    ],
    [
      "modelByChannel metadata",
      { channels: { modelByChannel: { openai: { whatsapp: "openai/gpt-5.4" } } } },
    ],
    ["disabled plugin", slackConfig({ entries: { slack: { enabled: false, config: {} } } })],
    ["disabled built-in channel", { channels: { slack: { botToken: "x", enabled: false } } }],
    [
      "disabled external channel",
      { channels: { matrix: { enabled: false } } },
      [{ id: "matrix", channels: ["matrix"] }],
    ],
    [
      "globally disabled plugins",
      slackConfig({
        enabled: false,
        allow: ["slack"],
        entries: { slack: { config: { botToken: "x" } } },
      }),
      [{ id: "slack", channels: ["slack"] }],
    ],
  ])("keeps auto-enable inactive for %s", (_name, config, plugins, envOverrides) => {
    const result = applyPluginAutoEnable({
      config,
      env: envOverrides ? makeIsolatedEnv(envOverrides) : env,
      ...(plugins ? { manifestRegistry: makeRegistry(plugins) } : {}),
    });
    expect(result.config).toStrictEqual(config ?? {});
    expect(result.changes).toStrictEqual([]);
    if (!config || Object.keys(config).length === 0) {
      expect(result.autoEnabledReasons).toStrictEqual({});
    }
  });

  it.each([{ allow: ["telegram"] }, { allow: [] }])(
    "auto-enables built-in channels with allowlist $allow",
    ({ allow }) => {
      const result = autoEnable(slackConfig({ allow }));
      expect(result.config.channels?.slack?.enabled).toBe(true);
      expect(result.config.plugins?.allow).toEqual(allow.length ? ["telegram", "slack"] : []);
      expect(result.changes.join("\n")).toContain("Slack configured, enabled automatically.");
      if (allow.length) {
        expect(result.config.plugins?.entries?.slack).toBeUndefined();
        expect(result.autoEnabledReasons).toEqual({ slack: ["slack configured"] });
        expect(Object.getPrototypeOf(result.autoEnabledReasons)).toBeNull();
      }
    },
  );

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
    const result = autoEnable(
      {
        tools: { web: { fetch: { provider: "evilfetch" } } },
        plugins: { allow: ["telegram"] },
      },
      [plugin("evil-plugin", { contracts: { webFetchProviders: ["evilfetch"] } })],
    );

    expect(result.config.plugins?.entries?.["evil-plugin"]).toBeUndefined();
    expect(result.config.plugins?.allow).toEqual(["telegram"]);
    expect(result.changes).toStrictEqual([]);
  });

  it("auto-enables bundled firecrawl when plugin-owned webFetch config exists", () => {
    const result = autoEnable(
      pluginConfig("firecrawl", { config: { webFetch: { apiKey: "firecrawl-key" } } }, [
        "telegram",
      ]),
    );
    expect(result.config.plugins?.entries?.firecrawl?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["telegram", "firecrawl"]);
    expect(result.changes).toContain("firecrawl web fetch configured, enabled automatically.");
  });

  it("bounds repeated model-candidate preference checks without changing plugin precedence", () => {
    const deny = ["blocked"];
    const denyChecks = vi.spyOn(deny, "includes");
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
    denyChecks.mockClear();

    const result = autoEnable(config, [
      plugin("primary", { providers: ["primary"] }),
      ...(
        [
          ["secondary", "primary"],
          ["blocked", "secondary"],
        ] as const
      ).map(([id, preferred]) =>
        plugin(id, {
          providers: [id],
          channelConfigs: { [id]: { schema: {}, preferOver: [preferred] } },
        }),
      ),
    ]);

    expect(denyChecks.mock.calls.length).toBeLessThanOrEqual(6);
    expect(result.config.plugins?.entries?.primary?.enabled).toBe(false);
    expect(result.config.plugins?.entries?.secondary?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.blocked).toBeUndefined();
    expect(result.changes).toEqual(["secondary/model-0 model configured, enabled automatically."]);
    expect(result.autoEnabledReasons.secondary).toEqual(["secondary/model-0 model configured"]);
  });

  it.each([
    ["OpenClaw preference", "openclaw", undefined, false],
    ["implicit subscription route with legacy Completions", undefined, "openai-completions", true],
  ] as const)("preserves %s for auth-profile models", (_name, runtime, api, codexEnabled) => {
    const config: OpenClawConfig = {
      auth: { profiles: { "openai:work": { provider: "openai", mode: "oauth" } } },
      ...(api ? modelConfig("openai", "https://api.openai.com/v1", { api }) : {}),
      agents: {
        entries: {
          main: {
            model: "openai/gpt-5.6-sol@openai:work",
            models: { "openai/gpt-5.6-sol": runtime ? { agentRuntime: { id: runtime } } : {} },
          },
        },
      },
      ...pluginConfig("openai", { enabled: true }, ["openai"]),
    };
    const result = autoEnable(config, [
      plugin("openai", { providers: ["openai"] }),
      plugin("codex", { activation: { onAgentHarnesses: ["codex"] } }),
    ]);

    expect(result.config.plugins?.entries?.codex?.enabled).toBe(codexEnabled ? true : undefined);
    expect(result.config.plugins?.allow).toEqual(codexEnabled ? ["openai", "codex"] : ["openai"]);
    expect(result.config.agents).toEqual(config.agents);
    expect(result.config.auth).toEqual(config.auth);
  });

  it("auto-enables a CLI backend owner when a provider runtime is configured", () => {
    const result = autoEnable(
      {
        ...modelConfig("anthropic", "https://api.anthropic.com", {
          agentRuntime: { id: "claude-cli" },
        }),
        plugins: { allow: ["telegram"] },
      },
      [plugin("anthropic", { providers: ["anthropic"], cliBackends: ["claude-cli"] })],
    );

    expect(result.config.plugins?.entries?.anthropic?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["telegram", "anthropic"]);
    expect(result.changes).toContain("claude-cli agent runtime configured, enabled automatically.");
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

    const params = { config: {}, env: persistedEnv };
    const result = applyPluginAutoEnable(params);
    expect(result.config).toStrictEqual({});
    expect(result.changes).toStrictEqual([]);
  });

  it.each([
    { id: "codex", entry: { enabled: true }, expected: ["glueclaw", "codex"] },
    { id: "missing-plugin", entry: { config: { token: "x" } }, expected: ["glueclaw"] },
  ])(
    "preserves only installed or official entries in plugins.allow: $id",
    ({ id, entry, expected }) => {
      const result = materializePluginAutoEnableCandidates({
        config: pluginConfig(id, entry, ["glueclaw"]),
        candidates: [],
        env,
        manifestRegistry: makeRegistry([]),
      });
      expect(result.config.plugins?.allow).toEqual(expected);
      if (id === "codex") {
        expect(result.changes).toContain("codex plugin config present, added to plugin allowlist.");
      } else {
        expect(result.changes).toStrictEqual([]);
      }
    },
  );

  it("does not re-emit built-in auto-enable changes when rerun with plugins.allow set", () => {
    const first = autoEnable({
      channels: { whatsapp: { allowFrom: ["+15555550123"] } },
      plugins: { allow: ["telegram"] },
    });

    const second = autoEnable(first.config);

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
    const config = pluginConfig("browser", { config: {} });

    const params = { config, discovery: emptyDiscovery, env, manifestRegistry };
    const first = applyPluginAutoEnable(params);
    const second = applyPluginAutoEnable(params);

    expect(second).toBe(first);
    expect(setupRegistryMock.resolvePluginSetupAutoEnableReasons).toHaveBeenCalledTimes(1);

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const third = applyPluginAutoEnable(params);

    expect(third).not.toBe(first);
    expect(third).toEqual(first);
    expect(setupRegistryMock.resolvePluginSetupAutoEnableReasons).toHaveBeenCalledTimes(2);
  });

  it.each(["array replacement", "lifecycle mutation"])(
    "refreshes cached auto-enable after %s",
    (change) => {
      const discovery: PluginDiscoveryResult = { candidates: [], diagnostics: [] };
      const manifestRegistry = makeRegistry([
        { id: "cache-channel-plugin", channels: ["cache-channel"] },
      ]);
      const params = {
        config: {},
        discovery,
        manifestRegistry,
        env: makeIsolatedEnv({ CACHE_CHANNEL_TOKEN: "configured" }),
      };
      const first = applyPluginAutoEnable(params);
      expect(first.config.plugins?.entries?.["cache-channel-plugin"]).toBeUndefined();
      const candidate = makeBundledChannelCandidate({
        pluginId: "cache-channel-plugin",
        channelId: "cache-channel",
      });
      if (change === "array replacement") {
        discovery.candidates = [candidate];
      } else {
        discovery.candidates.push(candidate);
        clearPluginMetadataLifecycleCaches();
      }
      const second = applyPluginAutoEnable(params);
      expect(second.config.plugins?.entries?.["cache-channel-plugin"]?.enabled).toBe(true);
      expect(second).not.toBe(first);
      if (change === "array replacement") {
        manifestRegistry.plugins = [];
        const third = applyPluginAutoEnable(params);
        expect(third.config.plugins?.entries?.["cache-channel-plugin"]).toBeUndefined();
        expect(applyPluginAutoEnable(params)).toBe(third);
      }
    },
  );

  it("does not reuse same-turn results for omitted metadata after current snapshot replacement", () => {
    const config: OpenClawConfig = { channels: { apn: { someKey: "value" } } };
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

  it("carries loader resolution facts onto a config the auto-enable rewrite rebuilt", () => {
    const unresolvedPath = "channels.a2a.peers.hermes.outboundToken";
    const config: OpenClawConfig = {
      channels: {
        slack: { botToken: "${SLACK_UNSET_TOKEN}" },
        a2a: {
          peers: { hermes: { token: "inbound-secret", outboundToken: "${A2A_UNSET_OUT}" } },
        },
      },
    };
    setConfigResolutionFacts(
      config,
      createConfigResolutionFacts([
        { varName: "A2A_UNSET_OUT", configPath: unresolvedPath },
        { varName: "SLACK_UNSET_TOKEN", configPath: "channels.slack.botToken" },
      ]),
    );

    const result = applyPluginAutoEnable({ config, env });

    expect(result.config).not.toBe(config);
    expect(result.config.channels?.slack?.enabled).toBe(true);
    expect(result.config.channels?.slack?.botToken).toBe("${SLACK_UNSET_TOKEN}");
    expect(hasUnresolvedConfigPath(result.config, "channels.slack.botToken")).toBe(true);
    expect(hasUnresolvedConfigPath(result.config, unresolvedPath)).toBe(true);
    expect(hasUnresolvedConfigPath(result.config, "channels.a2a.peers.hermes.token")).toBe(false);
  });

  it("leaves a config without loader facts without facts", () => {
    const config: OpenClawConfig = { channels: { slack: { botToken: "x" } } };
    const result = applyPluginAutoEnable({ config, env });
    expect(result.config).not.toBe(config);
    expect(getConfigResolutionFacts(result.config)).toBeNull();
  });
});
