import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { agentsListCommand } from "../../commands/agents.commands.list.js";
import { createTestRuntime } from "../../commands/test-runtime-config-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
  resolveReadOnlyChannelPluginsForConfig,
} from "./read-only.js";
import { writeExternalSetupChannelPlugin } from "./read-only.test-support.js";

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

function setupFixture(
  options: Parameters<typeof writeExternalSetupChannelPlugin>[0] = {},
  channels?: Parameters<typeof externalConfig>[1],
) {
  const fixture = writeExternalSetupChannelPlugin({ pluginId: "external-chat-plugin", ...options });
  return { ...fixture, cfg: externalConfig(fixture.pluginDir, channels, "external-chat-plugin") };
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

function providerFixture(accounts: Record<string, { name?: string }>, accountIds = ["ops"]) {
  const fixture = writeBundledSetupChannelPlugin();
  const { bundledRoot, channelId, pluginId } = fixture;
  const cfg = {
    agents: { entries: { main: { workspace: bundledRoot } } },
    channels: {
      [channelId]: { enabled: true, name: "Root name is not an account fallback", accounts },
    },
    plugins: { allow: [pluginId] },
    bindings: accountIds.map((accountId) => ({
      type: "route" as const,
      agentId: "main",
      match: { channel: channelId, accountId },
    })),
  } satisfies OpenClawConfig;
  return { ...fixture, cfg };
}

let providerConfig: OpenClawConfig;
// mock-isolation: Only the public provider projection receives fixture-owned config, without operator reads.
vi.mock("../../commands/config-validation.js", () => ({
  requireValidConfig: async () => providerConfig,
}));
// mock-isolation: Synthetic roster is already admitted; no state database is needed for account display.
vi.mock("../../state/agent-database-admission.js", () => ({
  hasAgentDatabaseAdmissions: () => true,
  evaluateAgentDatabaseAdmissions: async () => [],
  recordAgentDatabaseAdmissions: () => undefined,
  readAgentDatabaseAdmissionRefusal: () => undefined,
}));
// mock-isolation: Synthetic roster has no durable provenance; real plugin discovery stays unmocked.
vi.mock("../../state/agent-provenance.js", () => ({
  listAgentProvenance: async () => [],
  readAgentProvenanceForDisplay: async () => [],
}));

async function providerLines(cfg: ReturnType<typeof providerFixture>["cfg"]) {
  providerConfig = cfg;
  const runtime = {
    ...createTestRuntime(),
    writeStdout: vi.fn(),
    writeJson: vi.fn<(value: unknown) => void>(),
  };
  await agentsListCommand({ bindings: true, json: true }, runtime);
  return runtime.writeJson.mock.calls[0]?.[0];
}

function manifestFixture(
  channels?: Parameters<typeof externalConfig>[1],
  options: Parameters<typeof writeExternalSetupChannelPlugin>[0] = {},
  includeSetupFallbackPlugins?: boolean,
) {
  const fixture = setupFixture(
    { setupEntry: false, manifestChannelConfig: true, ...options },
    channels,
  );
  const plugins = listReadOnlyChannelPluginsForConfig(
    fixture.cfg,
    coldOptions(includeSetupFallbackPlugins),
  );
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

function writeBundledSetupChannelPlugin(options: { persistedAuthPath?: string } = {}) {
  const bundledRoot = makePluginLoaderTempDir();
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;
  const pluginId = "bundled-chat";
  const channelId = pluginId;
  const envVar = "BUNDLED_CHAT_TOKEN";
  const pluginDir = path.join(bundledRoot, pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  const fullMarker = path.join(pluginDir, "full-loaded.txt");
  const setupMarker = path.join(pluginDir, "setup-loaded.txt");
  const writeSource = (name: string, source: string) =>
    fs.writeFileSync(path.join(pluginDir, name), source, "utf8");
  const writeJson = (name: string, value: unknown) => writeSource(name, JSON.stringify(value));
  const meta = {
    id: channelId,
    label: "Bundled Chat",
    selectionLabel: "Bundled Chat",
    docsPath: `/channels/${channelId}`,
    blurb: "bundled setup entry",
  };
  writeJson("package.json", {
    name: `@openclaw/${pluginId}`,
    version: "1.0.0",
    type: "commonjs",
    openclaw: {
      extensions: ["./index.cjs"],
      setupEntry: "./setup-entry.cjs",
      channel: {
        ...meta,
        configuredState: { env: { anyOf: [envVar] } },
        persistedAuthState: options.persistedAuthPath
          ? { specifier: "./auth-state.cjs", exportName: "hasAuth" }
          : undefined,
      },
    },
  });
  if (options.persistedAuthPath) {
    writeSource(
      "auth-state.cjs",
      `exports.hasAuth = () => require("node:fs").existsSync(${JSON.stringify(options.persistedAuthPath)});\n`,
    );
  }
  writeJson("openclaw.plugin.json", {
    id: pluginId,
    configSchema: EMPTY_PLUGIN_SCHEMA,
    channels: [channelId],
  });
  writeSource(
    "index.cjs",
    `require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded", "utf-8");`,
  );
  writeSource(
    "setup-entry.cjs",
    `module.exports = {
  kind: "bundled-channel-setup-entry",
  loadSetupPlugin() {
    require("node:fs").writeFileSync(${JSON.stringify(setupMarker)}, "loaded", "utf-8");
    return {
      id: ${JSON.stringify(channelId)},
      meta: ${JSON.stringify(meta)},
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ accountId: "default", token: "configured" }),
      },
      outbound: { deliveryMode: "direct" },
    };
  },
};`,
  );

  return { bundledRoot, pluginDir, fullMarker, setupMarker, pluginId, channelId, envVar };
}

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
  vi.unstubAllEnvs();
  resetPluginLoaderTestStateForTest();
  resetPluginRuntimeStateForTest();
});

afterAll(cleanupPluginLoaderFixturesForTest);

describe("listReadOnlyChannelPluginsForConfig", () => {
  it.each([
    [" Operations desk ", "Operations desk", "ops (Operations desk)"],
    [undefined, undefined, "ops"],
  ])(
    "keeps concrete account labels on the real cold adapter (%s)",
    async (name, expectedName, expected) => {
      const { cfg, channelId, setupMarker, fullMarker } = providerFixture(
        { ops: { name }, plain: {}, unbound: { name: "Unbound account" } },
        ["ops", "plain"],
      );
      const originalConfig = JSON.stringify(cfg);

      const output = await providerLines(cfg);

      expect(output).toMatchObject([
        { providers: [`Bundled Chat ${expected}: configured`, "Bundled Chat plain: configured"] },
      ]);
      expect(
        await providerLines({
          ...cfg,
          bindings: [
            { type: "route", agentId: "main", match: { channel: channelId, accountId: "*" } },
          ],
        }),
      ).toMatchObject([
        {
          providers: expect.arrayContaining(["Bundled Chat unbound (Unbound account): configured"]),
        },
      ]);
      const adapter = findPlugin(listReadOnlyChannelPluginsForConfig(cfg), channelId);
      const account = expectRecordFields(adapter?.config.resolveAccount(cfg, "ops"), {
        accountId: "ops",
        name: expectedName,
      });
      expect(account.config).toBe(cfg.channels[channelId]?.accounts.ops);
      expect(JSON.stringify(cfg)).toBe(originalConfig);
      expectMarkers(setupMarker, fullMarker);
    },
  );

  it("keeps loaded inspector names ahead of manifest config names", async () => {
    const { cfg, channelId, pluginId, setupMarker, fullMarker } = providerFixture({
      ops: { name: "Cold config name" },
    });
    const resolveAccount = vi.fn(() => {
      throw new Error("loaded inspector must own account metadata");
    });
    const plugin = createChannelTestPluginBase({
      id: channelId,
      label: "Loaded Chat",
      config: {
        listAccountIds: () => ["ops"],
        resolveAccount,
        inspectAccount: (_cfg, accountId) => ({
          accountId,
          name: "Inspector name",
          enabled: true,
          configured: true,
        }),
      },
    });
    setActivePluginRegistry(createTestRegistry([{ pluginId, plugin, source: "test" }]));

    expect(await providerLines(cfg)).toMatchObject([
      { providers: ["Loaded Chat ops (Inspector name): configured"] },
    ]);
    expect(resolveAccount).not.toHaveBeenCalled();
    expectMarkers(setupMarker, fullMarker);
  });

  it("keeps explicitly supplied metadata inventories separate for the same config", () => {
    const { pluginDir } = writeExternalSetupChannelPlugin({
      setupEntry: false,
      manifestChannelConfig: true,
    });
    const cfg = externalConfig(pluginDir);
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
      (metadataSnapshot) =>
        listReadOnlyChannelPluginsForConfig(cfg, {
          metadataSnapshot,
          includePersistedAuthState: false,
        }).find((plugin) => plugin.id === "external-chat")?.meta.label,
    );

    expect(labels).toEqual([
      "External Chat Manifest",
      "Replacement inventory",
      "External Chat Manifest",
    ]);
  });

  it("reuses manifest adapters while account settings and channel policy stay live", () => {
    const { pluginDir, setupMarker, fullMarker } = writeExternalSetupChannelPlugin({
      manifestChannelConfig: true,
    });
    const cfg = externalConfig(pluginDir);
    const metadataSnapshot = resolvePluginMetadataSnapshot({ config: cfg });
    const first = findPlugin(listReadOnlyChannelPluginsForConfig(cfg, { metadataSnapshot }));
    const changed = externalConfig(pluginDir, {
      "external-chat": { accounts: { ops: { token: "changed" } } },
    });
    const second = findPlugin(listReadOnlyChannelPluginsForConfig(changed, { metadataSnapshot }));

    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(second?.config.listAccountIds(changed)).toEqual(["ops"]);
    expect(second?.config.resolveAccount(changed, "ops")).toEqual({
      accountId: "ops",
      config: { token: "changed" },
    });
    for (const [channelEnabled, accountEnabled, expected] of [
      [true, false, false],
      [true, true, true],
      [true, undefined, true],
      [false, true, false],
      [undefined, false, false],
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
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      manifestChannelIds: ["external-chat", "sibling-chat"],
      manifestChannelConfig: true,
      packagePresentation: {
        selectionLabel: "Package Chat (picker)",
        detailLabel: "Package Chat Bot",
        systemImage: "bubble.left",
      },
    });
    const plugins = listReadOnlyChannelPluginsForConfig(
      externalConfig(pluginDir, {
        "external-chat": { token: "configured" },
        "sibling-chat": { token: "configured" },
      }),
      { includePersistedAuthState: false },
    );
    const catalog = buildChannelUiCatalog(plugins);
    expect([catalog.byId["external-chat"], catalog.byId["sibling-chat"]]).toEqual([
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
    ]);
    expectMarkers(setupMarker, fullMarker);
  });

  it("uses activation source config to discover channel setup metadata after secret stripping", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin();
    const plugins = listReadOnlyChannelPluginsForConfig(
      externalConfig(pluginDir, { "external-chat": {} }),
      {
        activationSourceConfig: externalConfig(pluginDir),
        ...coldOptions(true),
      },
    );

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
    const { pluginDir } = writeExternalSetupChannelPlugin();
    const setupPath = path.join(pluginDir, "setup-entry.cjs");
    const dependencyPath = path.join(pluginDir, "setup-dependency.cjs");
    const initialSource = fs
      .readFileSync(setupPath, "utf8")
      .replace('blurb: "setup entry",', 'blurb: require("./setup-dependency.cjs"),');
    fs.writeFileSync(dependencyPath, 'module.exports = "before";\n', "utf8");
    fs.writeFileSync(setupPath, initialSource, "utf8");
    const cfg = externalConfig(pluginDir);
    const options = coldOptions(true);

    const first = listReadOnlyChannelPluginsForConfig(cfg, options);
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

    const second = listReadOnlyChannelPluginsForConfig(cfg, options);
    expect(findPlugin(second)?.meta.blurb).toBe("updated:after");
  });

  it("clones setup-only plugins for every configured owned channel when setup id matches one channel", async () => {
    const {
      pluginDir,
      cfg: discoveryConfig,
      fullMarker,
      setupMarker,
    } = setupFixture(siblingSetup, siblingChannels);
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
    const plugins = listReadOnlyChannelPluginsForConfig(discoveryConfig, coldOptions(true));

    const betaPlugin = findPlugin(plugins, "beta-chat");
    for (const id of ["alpha-chat", "beta-chat"]) {
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
  });

  it("clones setup-only plugins when only another owned channel is configured", () => {
    const { cfg, fullMarker, setupMarker } = setupFixture(siblingSetup, {
      "beta-chat": siblingChannels["beta-chat"],
    });
    const plugins = listReadOnlyChannelPluginsForConfig(cfg, coldOptions(true));

    expect(pluginIds(plugins)).not.toContain("alpha-chat");
    const betaPlugin = findPlugin(plugins, "beta-chat");
    expect(betaPlugin?.meta.id).toBe("beta-chat");
    expectSecretTarget(betaPlugin, "beta-chat");
    expect(
      betaPlugin?.config.resolveAccount({ channels: { "beta-chat": { token: "beta-token" } } })
        .token,
    ).toBe("beta-token");
    expectMarkers(setupMarker, fullMarker, true);
  });

  it("uses manifest channel configs when no setup entry exists", () => {
    const { cfg, plugin, fullMarker, setupMarker } = manifestFixture(
      {
        "external-chat": {
          defaultAccount: "Ops Team",
          accounts: {
            "Ops Team": { token: "configured" },
            chat: { token: "chat-token" },
          },
        },
      },
      {},
      true,
    );
    expect(plugin?.meta.blurb).toBe("manifest config");
    expect(plugin?.config.defaultAccountId?.(cfg)).toBe("ops-team");
    expectMarkers(setupMarker, fullMarker);
  });

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
          "external-chat": { defaultAccount: "ops", accounts: { ops: {}, alerts: {} } },
        });
        expect(plugin?.config.listAccountIds(namedCfg)).toEqual(["alerts", "ops"]);
        expect(plugin?.config.defaultAccountId?.(namedCfg)).toBe("ops");
        expectMarkers(setupMarker, fullMarker);
      }
      const plugins = listReadOnlyChannelPluginsForConfig(cfg, coldOptions(true));
      expectExternalChatSetupOnlyPluginLoaded({ plugins, setupMarker, fullMarker });
    },
  );

  it("sanitizes terminal control sequences from manifest channel metadata", () => {
    const { plugin } = manifestFixture(undefined, {
      manifestChannelLabel: "External\u001b[31m Chat\u001b[0m",
      manifestChannelDescription: "manifest\u001b[2K config",
    });
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
    const { cfg, fullMarker, setupMarker } = setupFixture(
      {},
      { "external-chat": { enabled: false } },
    );
    const plugins = listReadOnlyChannelPluginsForConfig(
      cfg,
      coldOptions(undefined, { ...process.env, EXTERNAL_CHAT_TOKEN: "configured" }),
    );

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
    const { cfg, fullMarker, setupMarker } = setupFixture({
      manifestChannelIds: ["external-chat"],
      setupChannelId: "spoofed-chat",
    });
    const plugins = listReadOnlyChannelPluginsForConfig(cfg, {
      env: { ...process.env },
      includeSetupFallbackPlugins: true,
    });

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
    const { cfg, pluginDir, fullMarker, setupMarker } = setupFixture({
      manifestChannelConfig: true,
      setupRequiresRuntime: missing,
    });
    fs.writeFileSync(
      path.join(pluginDir, "setup-entry.cjs"),
      `throw new Error("Cannot find module 'ansi-escapes'");`,
      "utf-8",
    );

    const result = resolveReadOnlyChannelPluginsForConfig(cfg, {
      env: { ...process.env },
      includeSetupFallbackPlugins: true,
    });

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
