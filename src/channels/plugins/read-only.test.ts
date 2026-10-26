import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
} from "../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import {
  rebasePluginMetadataSnapshotManifestRegistry,
  resolvePluginMetadataSnapshot,
  restorePluginMetadataSnapshot,
} from "../../plugins/plugin-metadata-snapshot.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { channelHasConfiguredState, resolveChannelAccount } from "../account-resolution.js";
import { buildChannelUiCatalog } from "./catalog.js";
import {
  listReadOnlyChannelPluginsForConfig,
  listReadOnlyChannelPluginsForConfigAsync,
  resolveReadOnlyChannelPluginsForConfig,
} from "./read-only.js";
import {
  writeBundledSetupChannelPlugin,
  writeExternalSetupChannelPlugin,
} from "./read-only.test-support.js";

type ReadOnlyPlugins = ReturnType<typeof listReadOnlyChannelPluginsForConfig>;

function pluginIds(plugins: ReadOnlyPlugins): string[] {
  return plugins.map((entry) => entry.id);
}

function externalConfig(
  pluginDir: string,
  channels: Record<string, Record<string, unknown>> | null = {
    "external-chat": { token: "configured" },
  },
  pluginId = "external-chat",
): Parameters<typeof listReadOnlyChannelPluginsForConfig>[0] {
  return {
    ...(channels === null ? {} : { channels }),
    plugins: { load: { paths: [pluginDir] }, allow: [pluginId] },
  };
}

function coldOptions(includeSetupFallbackPlugins?: boolean, env = process.env) {
  return {
    env: { ...env },
    includePersistedAuthState: false,
    ...(includeSetupFallbackPlugins === undefined ? {} : { includeSetupFallbackPlugins }),
  };
}

function externalFixture(
  options: Parameters<typeof writeExternalSetupChannelPlugin>[0] = {},
  channels?: Parameters<typeof externalConfig>[1],
) {
  const fixture = writeExternalSetupChannelPlugin(options);
  const cfg = externalConfig(fixture.pluginDir, channels, fixture.pluginId);
  const resolve = (overrides: Parameters<typeof resolveReadOnlyChannelPluginsForConfig>[1] = {}) =>
    resolveReadOnlyChannelPluginsForConfig(cfg, { ...coldOptions(), ...overrides });
  return {
    ...fixture,
    cfg,
    resolve,
    list: (overrides?: Parameters<typeof resolve>[0]) => resolve(overrides).plugins,
  };
}

function setupFixture(
  options: Parameters<typeof writeExternalSetupChannelPlugin>[0] = {},
  channels?: Parameters<typeof externalConfig>[1],
) {
  return externalFixture({ pluginId: "external-chat-plugin", ...options }, channels);
}

const siblingChannels = {
  "alpha-chat": { token: "alpha-token" },
  "beta-chat": { token: "beta-token" },
};
const siblingSetup = {
  channelId: "alpha-chat",
  manifestChannelIds: ["alpha-chat", "beta-chat"],
  setupChannelId: "alpha-chat",
};

function manifestFixture(
  channels?: Parameters<typeof externalConfig>[1],
  options: Parameters<typeof writeExternalSetupChannelPlugin>[0] = {},
  includeSetupFallbackPlugins?: boolean,
) {
  const fixture = setupFixture(
    { setupEntry: false, manifestChannelConfig: true, ...options },
    channels,
  );
  const plugins = fixture.list({ includeSetupFallbackPlugins });
  return { ...fixture, plugins, plugin: findPlugin(plugins) };
}

function expectMarkers(setupMarker: string, fullMarker: string, setupLoaded = false) {
  expect(fs.existsSync(setupMarker)).toBe(setupLoaded);
  expect(fs.existsSync(fullMarker)).toBe(false);
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  expect(record).toMatchObject(expected);
  return record as Record<string, unknown>;
}

function findPlugin(plugins: ReadOnlyPlugins, id = "external-chat") {
  return plugins.find((entry) => entry.id === id);
}

function expectSecretTarget(plugin: ReturnType<typeof findPlugin>, channelId = "external-chat") {
  expect(plugin?.secrets?.secretTargetRegistryEntries).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: `channels.${channelId}.token` })]),
  );
}

vi.mock("../../plugins/bundled-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/bundled-dir.js")>();
  return {
    ...actual,
    resolveBundledPluginsDir: (env: NodeJS.ProcessEnv = process.env) =>
      env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? actual.resolveBundledPluginsDir(env),
  };
});

function expectExternalChatSetupOnlyPluginLoaded(params: {
  plugins: ReadOnlyPlugins;
  setupMarker: string;
  fullMarker: string;
}) {
  const plugin = findPlugin(params.plugins);
  expect(plugin?.meta.blurb).toBe("setup entry");
  expectSecretTarget(plugin);
  expectMarkers(params.setupMarker, params.fullMarker, true);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetPluginLoaderTestStateForTest();
  resetPluginRuntimeStateForTest();
});

afterAll(cleanupPluginLoaderFixturesForTest);

describe("listReadOnlyChannelPluginsForConfig", () => {
  it.each(["registered", "ineligible"])(
    "skips saved-auth I/O for %s channels until discovery needs it",
    async (state) => {
      const stateDir = makePluginLoaderTempDir();
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const persistedAuthPath = path.join(stateDir, "linked-auth");
      const { channelId, pluginDir, setupMarker, fullMarker } = writeBundledSetupChannelPlugin({
        persistedAuthPath,
      });
      const readsPath = path.join(stateDir, "auth-reads");
      fs.writeFileSync(
        path.join(pluginDir, "auth-state.cjs"),
        `exports.hasAuth = () => {
        const fs = require("node:fs");
        fs.appendFileSync(${JSON.stringify(readsPath)}, "read\\n");
        return fs.existsSync(${JSON.stringify(persistedAuthPath)});
      };`,
      );
      fs.writeFileSync(persistedAuthPath, "linked");
      const cfg = {
        plugins: {
          allow: [state === "ineligible" ? "other-plugin" : channelId],
          entries: { [channelId]: { enabled: true } },
        },
      };
      const metadataSnapshot = resolvePluginMetadataSnapshot({ config: cfg });
      const loaded = createChannelTestPluginBase({ id: channelId });
      setActivePluginRegistry(
        createTestRegistry(
          state === "registered"
            ? [{ pluginId: channelId, plugin: loaded, source: pluginDir }]
            : [],
        ),
      );
      const read = () => listReadOnlyChannelPluginsForConfigAsync(cfg, { metadataSnapshot });

      expect(pluginIds(await read())).toEqual(state === "registered" ? [channelId] : []);
      expect(fs.existsSync(readsPath)).toBe(false);

      setActivePluginRegistry(createTestRegistry([]));
      cfg.plugins.allow = [channelId];
      expect(pluginIds(await read())).toContain(channelId);
      expect(fs.readFileSync(readsPath, "utf8")).toBe("read\n");
      fs.unlinkSync(persistedAuthPath);
      expect(pluginIds(await read())).not.toContain(channelId);
      expectMarkers(setupMarker, fullMarker);
    },
  );

  it("keeps explicitly supplied metadata inventories separate for the same config", () => {
    const { cfg, list } = externalFixture({ setupEntry: false, manifestChannelConfig: true });
    const original = resolvePluginMetadataSnapshot({ config: cfg });
    const replacement = restorePluginMetadataSnapshot(
      rebasePluginMetadataSnapshotManifestRegistry(original, {
        ...original.manifestRegistry,
        plugins: original.plugins.map((record) => ({
          ...record,
          channelConfigs: {
            ...record.channelConfigs,
            "external-chat": {
              ...record.channelConfigs?.["external-chat"],
              schema: EMPTY_PLUGIN_SCHEMA,
              label: "Replacement inventory",
            },
          },
        })),
      }),
    );
    const labels = [original, replacement, original].map(
      (metadataSnapshot) => findPlugin(list({ metadataSnapshot }))?.meta.label,
    );

    expect(labels).toEqual([
      "External Chat Manifest",
      "Replacement inventory",
      "External Chat Manifest",
    ]);
  });

  it("reuses manifest adapters while account settings and channel policy stay live", () => {
    const { cfg, list, pluginDir, setupMarker, fullMarker } = externalFixture({
      manifestChannelConfig: true,
    });
    const metadataSnapshot = resolvePluginMetadataSnapshot({ config: cfg });
    const first = findPlugin(list({ metadataSnapshot }));
    const changed = externalConfig(pluginDir, {
      "external-chat": {
        name: "Root is not an account-name fallback",
        accounts: { ops: { token: "changed", name: " Operations desk " }, plain: {} },
      },
    });
    const originalConfig = JSON.stringify(changed);
    const second = findPlugin(listReadOnlyChannelPluginsForConfig(changed, { metadataSnapshot }));

    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(second?.config.listAccountIds(changed)).toEqual(["ops", "plain"]);
    const namedAccount = expectRecordFields(second?.config.resolveAccount(changed, "ops"), {
      accountId: "ops",
      name: "Operations desk",
      config: { token: "changed", name: " Operations desk " },
    });
    expect(namedAccount.config).toBe(changed.channels?.["external-chat"]?.accounts.ops);
    expect(second?.config.resolveAccount(changed, "plain").name).toBeUndefined();
    expect(JSON.stringify(changed)).toBe(originalConfig);
    for (const [channelEnabled, accountEnabled, expected] of [
      [true, false, false],
      [true, true, true],
      [true, undefined, true],
      [false, true, false],
    ] as const) {
      const current = externalConfig(pluginDir, {
        "external-chat": {
          enabled: channelEnabled,
          accounts: { ops: { enabled: accountEnabled } },
        },
      });
      const account = second?.config.resolveAccount(current, "ops");
      expect(second?.config.isEnabled?.(account, current)).toBe(expected);
    }
    expect(
      pluginIds(
        listReadOnlyChannelPluginsForConfig(
          { ...changed, plugins: { ...changed.plugins, deny: ["external-chat"] } },
          { metadataSnapshot },
        ),
      ),
    ).not.toContain("external-chat");
    expectMarkers(setupMarker, fullMarker);
  });

  it("reevaluates persisted auth without replacing manifest adapters or loading channel runtime", () => {
    const stateDir = makePluginLoaderTempDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const persistedAuthPath = path.join(stateDir, "linked-auth");
    const { channelId, setupMarker, fullMarker } = writeBundledSetupChannelPlugin({
      persistedAuthPath,
    });
    const cfg = { plugins: { allow: [channelId], entries: { [channelId]: { enabled: true } } } };
    const metadataSnapshot = resolvePluginMetadataSnapshot({ config: cfg });
    const read = () => listReadOnlyChannelPluginsForConfig(cfg, { metadataSnapshot });

    expect(pluginIds(read())).not.toContain(channelId);
    fs.writeFileSync(persistedAuthPath, "linked", "utf8");
    const linked = read().find((plugin) => plugin.id === channelId);
    expect(linked).toBeDefined();
    fs.unlinkSync(persistedAuthPath);
    expect(pluginIds(read())).not.toContain(channelId);
    fs.writeFileSync(persistedAuthPath, "linked again", "utf8");
    expect(read().find((plugin) => plugin.id === channelId)).toBe(linked);
    expectMarkers(setupMarker, fullMarker);
  });

  it("keeps package presentation on its declared channel", () => {
    const { list, fullMarker, setupMarker } = externalFixture(
      {
        manifestChannelIds: ["external-chat", "sibling-chat"],
        manifestChannelConfig: true,
        packagePresentation: {
          selectionLabel: "Package Chat (picker)",
          detailLabel: "Package Chat Bot",
          systemImage: "bubble.left",
        },
      },
      {
        "external-chat": { token: "configured" },
        "sibling-chat": { token: "configured" },
      },
    );
    const catalog = buildChannelUiCatalog(list());
    expect(catalog.entries).toEqual(
      expect.arrayContaining([
        {
          id: "external-chat",
          label: "External Chat Manifest",
          detailLabel: "Package Chat Bot",
          systemImage: "bubble.left",
        },
        {
          id: "sibling-chat",
          label: "External Chat Manifest",
          detailLabel: "External Chat Manifest",
        },
      ]),
    );
    expectMarkers(setupMarker, fullMarker);
  });

  it("uses activation source config to discover channel setup metadata after secret stripping", () => {
    const { pluginDir, list, fullMarker, setupMarker } = externalFixture(
      {},
      { "external-chat": {} },
    );
    const plugins = list({
      activationSourceConfig: externalConfig(pluginDir),
      includeSetupFallbackPlugins: true,
    });

    expectExternalChatSetupOnlyPluginLoaded({ plugins, setupMarker, fullMarker });
  });

  it("refreshes cached read-only channel plugins when the active channel registry changes", () => {
    const cfg = { channels: { "external-chat": { token: "configured" } } } as never;
    const install = (blurb: string) => {
      const base = createChannelTestPluginBase({ id: "external-chat" as never });
      const plugin = { ...base, meta: { ...base.meta, blurb } };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: `${blurb}-plugin`, plugin, source: "test" }]),
      );
      return findPlugin(
        listReadOnlyChannelPluginsForConfig(cfg, { includeSetupFallbackPlugins: true }),
      );
    };
    const first = install("first");
    const second = install("second");
    expect([first?.meta.blurb, second?.meta.blurb]).toEqual(["first", "second"]);
  });

  it("reloads replaced installed channel setup modules and their dependencies", () => {
    const { pluginDir, list } = externalFixture();
    const setupPath = path.join(pluginDir, "setup-entry.cjs");
    const dependencyPath = path.join(pluginDir, "setup-dependency.cjs");
    const initialSource = fs
      .readFileSync(setupPath, "utf8")
      .replace('blurb: "setup entry",', 'blurb: require("./setup-dependency.cjs"),');
    fs.writeFileSync(dependencyPath, 'module.exports = "before";\n', "utf8");
    fs.writeFileSync(setupPath, initialSource, "utf8");
    const first = list({ includeSetupFallbackPlugins: true });
    expect(findPlugin(first)?.meta.blurb).toBe("before");

    fs.writeFileSync(dependencyPath, 'module.exports = "after";\n', "utf8");
    fs.writeFileSync(
      setupPath,
      initialSource.replace(
        'blurb: require("./setup-dependency.cjs"),',
        'blurb: "updated:" + require("./setup-dependency.cjs"),',
      ),
      "utf8",
    );
    clearPluginMetadataLifecycleCaches();

    const second = list({ includeSetupFallbackPlugins: true });
    expect(findPlugin(second)?.meta.blurb).toBe("updated:after");
  });

  it.each([true, false])(
    "clones setup-only owned channels (setup channel configured=%s)",
    async (both) => {
      const { pluginDir, list, fullMarker, setupMarker } = setupFixture(
        siblingSetup,
        both ? siblingChannels : { "beta-chat": siblingChannels["beta-chat"] },
      );
      fs.appendFileSync(
        path.join(pluginDir, "setup-entry.cjs"),
        `
Object.assign(module.exports.plugin.config, {
  resolveAccountAsync: async (cfg, accountId) => ({
    ...module.exports.plugin.config.resolveAccount(cfg),
    accountId: accountId ?? "default",
  }),
  hasConfiguredStateAsync: async ({ cfg, env }) =>
    cfg.channels?.["alpha-chat"]?.token === env?.FIXTURE_CHANNEL_TOKEN,
});`,
        "utf8",
      );
      const plugins = list({ includeSetupFallbackPlugins: true });

      const betaPlugin = findPlugin(plugins, "beta-chat");
      expect(pluginIds(plugins).includes("alpha-chat")).toBe(both);
      for (const id of both ? ["alpha-chat", "beta-chat"] : ["beta-chat"]) {
        expect(findPlugin(plugins, id)?.meta).toMatchObject({ id, blurb: "setup entry" });
      }
      expectSecretTarget(betaPlugin, "beta-chat");
      if (!betaPlugin) {
        throw new Error("Expected configured beta channel");
      }
      const cfg = { channels: siblingChannels };
      expect(betaPlugin.config.resolveAccount(cfg).token).toBe("beta-token");
      const account = await resolveChannelAccount({ plugin: betaPlugin, cfg, accountId: "ops" });
      expect(account).toMatchObject({ accountId: "ops", token: "beta-token" });
      await expect(
        channelHasConfiguredState({
          plugin: betaPlugin,
          cfg,
          env: { FIXTURE_CHANNEL_TOKEN: "beta-token" },
        }),
      ).resolves.toBe(true);
      expect(cfg.channels["alpha-chat"].token).toBe("alpha-token");
      expectMarkers(setupMarker, fullMarker, true);
    },
  );

  it.each(["external", "bundled"])(
    "uses %s manifest inventory before loading setup runtime",
    (origin) => {
      const fixtureRoot = makePluginLoaderTempDir();
      const fixtureDir = path.join(fixtureRoot, "external-chat-plugin");
      fs.mkdirSync(fixtureDir);
      const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
        pluginDir: fixtureDir,
        pluginId: "external-chat-plugin",
        channelId: "external-chat",
        manifestChannelConfig: true,
      });
      const cfg = externalConfig(pluginDir, undefined, "external-chat-plugin");
      if (origin === "bundled") {
        vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
        vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", fixtureRoot);
        delete cfg.plugins?.load;
      }
      for (const includeSetupFallbackPlugins of [undefined, false]) {
        const result = resolveReadOnlyChannelPluginsForConfig(
          cfg,
          coldOptions(includeSetupFallbackPlugins),
        );
        expect(result).toMatchObject({ missingConfiguredChannelIds: [], loadFailures: [] });
        expect(
          result.manifestRecords.find((record) => record.id === "external-chat-plugin")?.origin,
        ).toBe(origin === "bundled" ? "bundled" : "config");

        const plugin = findPlugin(result.plugins);
        expect(plugin).toMatchObject({
          meta: {
            label: "External Chat Manifest",
            blurb: "manifest config",
            preferOver: ["legacy-external-chat"],
          },
          configSchema: {
            schema: { properties: { token: { type: "string" } } },
            uiHints: { token: { label: "Token", sensitive: true } },
          },
        });
        expect(
          plugin?.config.listAccountIds({ channels: { "external-chat": { token: "t" } } } as never),
        ).toEqual(["default"]);
        const account = plugin?.config.resolveAccount({
          channels: { "external-chat": { token: "configured" } },
        } as never);
        expect(account).toMatchObject({ accountId: "default", config: { token: "configured" } });
        const namedCfg = externalConfig(pluginDir, {
          "external-chat": { defaultAccount: "Ops Team", accounts: { "Ops Team": {}, alerts: {} } },
        });
        expect(plugin?.config.listAccountIds(namedCfg)).toEqual(["alerts", "ops-team"]);
        expect(plugin?.config.defaultAccountId?.(namedCfg)).toBe("ops-team");
        expectMarkers(setupMarker, fullMarker);
      }
      const plugins = listReadOnlyChannelPluginsForConfig(cfg, coldOptions(true));
      expectExternalChatSetupOnlyPluginLoaded({ plugins, setupMarker, fullMarker });
    },
  );

  it("sanitizes terminal control sequences from manifest channel metadata", () => {
    const { plugin } = manifestFixture(
      undefined,
      {
        manifestChannelLabel: "External\u001b[31m Chat\u001b[0m",
        manifestChannelDescription: "manifest\u001b[2K config",
      },
      true,
    );
    expect(plugin?.meta).toMatchObject({
      label: "External Chat",
      selectionLabel: "External Chat",
      blurb: "manifest config",
    });
  });

  it("ignores manifest channel configs with unsafe channel ids", () => {
    const unsafeChannelId = "__proto__";
    const { plugins, fullMarker, setupMarker } = manifestFixture(
      Object.fromEntries([[unsafeChannelId, { token: "configured" }]]),
      { channelId: unsafeChannelId, manifestChannelIds: [unsafeChannelId] },
    );

    expect(pluginIds(plugins)).not.toContain(unsafeChannelId);
    expectMarkers(setupMarker, fullMarker);
  });

  it("uses own normalized account ids for manifest channel account config", () => {
    const inheritedAccounts = Object.create({
      inherited: { token: "prototype-token" },
    }) as Record<string, unknown>;
    inheritedAccounts.default = { token: "default-token" };
    inheritedAccounts.named = { token: "named-token" };
    const { cfg, plugin } = manifestFixture({ "external-chat": { accounts: inheritedAccounts } });

    expect(plugin?.config.listAccountIds(cfg)).toEqual(["default", "named"]);
    expect(plugin?.config.resolveAccount(cfg, "__proto__")).toMatchObject({
      accountId: "default",
      config: { token: "default-token" },
    });
    const inheritedAccount = expectRecordFields(
      plugin?.config.resolveAccount(cfg, "inherited"),
      {},
    );
    expect(expectRecordFields(inheritedAccount.config, {}).token).not.toBe("prototype-token");
  });

  it("ignores manifest account keys that normalize to blocked object keys", () => {
    const { cfg, plugin } = manifestFixture({
      "external-chat": { accounts: { "constructor ": { token: "blocked-token" } } },
    });

    expect(plugin?.config.listAccountIds(cfg)).toEqual([]);
    const account = expectRecordFields(plugin?.config.resolveAccount(cfg, "default"), {
      accountId: "default",
    });
    expect(expectRecordFields(account.config, {}).token).toBeUndefined();
  });

  it("does not promote disabled external channels from manifest env", () => {
    const { list, fullMarker, setupMarker } = setupFixture(
      {},
      { "external-chat": { enabled: false } },
    );
    const plugins = list({ env: { ...process.env, EXTERNAL_CHAT_TOKEN: "configured" } });

    expect(pluginIds(plugins)).not.toContain("external-chat");
    expectMarkers(setupMarker, fullMarker);
  });

  it.each(["not-allowed", "channel-disabled", "enabled"])(
    "respects bundled channel policy with ambient credentials (%s)",
    (policy) => {
      const { channelId, envVar, fullMarker, pluginId, setupMarker } =
        writeBundledSetupChannelPlugin();
      const cfg =
        policy === "not-allowed"
          ? { plugins: { allow: ["memory-core"] } }
          : {
              ...(policy === "channel-disabled"
                ? { channels: { [channelId]: { enabled: false } } }
                : {}),
              plugins: {
                ...(policy === "enabled" ? { allow: [pluginId] } : {}),
                entries: { [pluginId]: { enabled: true } },
              },
            };
      const plugins = listReadOnlyChannelPluginsForConfig(
        cfg,
        coldOptions(true, { ...process.env, [envVar]: "configured" }),
      );
      if (policy === "enabled") {
        expect(findPlugin(plugins, channelId)?.meta.blurb).toBe("bundled setup entry");
      } else {
        expect(pluginIds(plugins)).not.toContain(channelId);
      }
      expectMarkers(setupMarker, fullMarker, policy === "enabled");
    },
  );

  it.each(["trusted", "untrusted", "denied"] as const)(
    "scopes external workspace setup imports by current policy (%s)",
    (policy) => {
      vi.stubEnv("EXTERNAL_CHAT_TOKEN", undefined);
      const workspaceDir = makePluginLoaderTempDir();
      const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", "external-chat-plugin");
      fs.mkdirSync(pluginDir, { recursive: true });
      const { fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
        pluginDir,
        pluginId: "external-chat-plugin",
        channelId: "external-chat",
      });
      const plugins = listReadOnlyChannelPluginsForConfig(
        {
          agents: { defaults: { workspace: workspaceDir } },
          channels: { "external-chat": { token: "configured" } },
          plugins: {
            allow: policy === "untrusted" ? [] : ["external-chat-plugin"],
            deny: policy === "denied" ? ["external-chat-plugin"] : [],
          },
        } as never,
        coldOptions(true),
      );

      const plugin = plugins.find((entry) => entry.id === "external-chat");
      const accepted = policy === "trusted";
      expect(plugin?.meta.blurb).toBe(accepted ? "setup entry" : undefined);
      expectMarkers(setupMarker, fullMarker, accepted);
    },
  );

  it("ignores external setup plugins that export an unrequested channel id", () => {
    const { list, fullMarker, setupMarker } = setupFixture({
      manifestChannelIds: ["external-chat"],
      setupChannelId: "spoofed-chat",
    });
    const plugins = list({ includeSetupFallbackPlugins: true });

    expect(pluginIds(plugins)).not.toContain("spoofed-chat");
    expect(pluginIds(plugins)).toContain("external-chat");
    expectMarkers(setupMarker, fullMarker, true);
  });

  it.runIf(process.platform !== "win32").each(["hardlink", "symlink"] as const)(
    "rejects external setup %s substitution after metadata discovery",
    (linkKind) => {
      const { cfg, pluginDir, fullMarker, setupMarker } = setupFixture();
      const options = coldOptions();
      const initial = resolveReadOnlyChannelPluginsForConfig(cfg, options);
      expect(pluginIds(initial.plugins)).toContain("external-chat");
      expect(fs.existsSync(setupMarker)).toBe(false);

      const setupEntry = path.join(pluginDir, "setup-entry.cjs");
      const hostileDir = makePluginLoaderTempDir();
      const hostileMarker = path.join(hostileDir, "executed.txt");
      const hostileSource = path.join(hostileDir, "payload.cjs");
      fs.writeFileSync(
        hostileSource,
        fs
          .readFileSync(setupEntry, "utf8")
          .replace(JSON.stringify(setupMarker), JSON.stringify(hostileMarker)),
        "utf8",
      );
      fs.unlinkSync(setupEntry);
      if (linkKind === "hardlink") {
        fs.linkSync(hostileSource, setupEntry);
        expect(fs.statSync(setupEntry).nlink).toBeGreaterThan(1);
      } else {
        fs.symlinkSync(hostileSource, setupEntry);
      }

      const result = resolveReadOnlyChannelPluginsForConfig(cfg, {
        ...options,
        includeSetupFallbackPlugins: true,
      });

      expect(fs.existsSync(hostileMarker)).toBe(false);
      expect(pluginIds(result.plugins)).toContain("external-chat");
      expect(result.loadFailures).toEqual([
        expect.objectContaining({
          channelId: "external-chat",
          pluginId: "external-chat-plugin",
          source: setupEntry,
          message: expect.stringContaining("Unable to open channel setup entry"),
        }),
      ]);
      expectMarkers(setupMarker, fullMarker);
    },
  );

  it.each([true, false])("reports setup failures (requiresRuntime=%s)", (missing) => {
    const { resolve, pluginDir, fullMarker, setupMarker } = setupFixture({
      manifestChannelConfig: true,
      setupRequiresRuntime: missing,
    });
    fs.writeFileSync(
      path.join(pluginDir, "setup-entry.cjs"),
      `throw new Error("Cannot find module 'ansi-escapes'");`,
      "utf-8",
    );

    const result = resolve({ includeSetupFallbackPlugins: true });

    expect(pluginIds(result.plugins).includes("external-chat")).toBe(!missing);
    expect(result.missingConfiguredChannelIds).toEqual(missing ? ["external-chat"] : []);
    expect(result.loadFailures).toEqual([
      expect.objectContaining({
        channelId: "external-chat",
        pluginId: "external-chat-plugin",
        message: expect.stringContaining("Cannot find module"),
      }),
    ]);
    expectMarkers(setupMarker, fullMarker);
  });
});
