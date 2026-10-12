// Gateway config reload tests cover changed-path detection, reload planning,
// plugin registry refresh, skill snapshot invalidation, and watcher behavior.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import {
  initializePublishedConfigRuntimeEnv,
  prepareConfigRuntimeEnv,
} from "../config/config-env-vars.js";
import { fingerprintConfigSnapshotAuthoredConfig } from "../config/config-journal-snapshot.js";
import {
  readConfigFileSnapshotForWrite,
  registerConfigWriteListener,
  replaceConfigFile,
} from "../config/config.js";
import type {
  ConfigFileSnapshot,
  ConfigWriteNotification,
  OpenClawConfig,
} from "../config/config.js";
import { createConfigIO, readConfigFileSnapshotForRuntimeTransaction } from "../config/io.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import {
  hashRuntimeConfigValue,
  registerRuntimeConfigWriteListener,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
  publishRuntimeConfigWrite,
} from "../config/runtime-write-application.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  clearCurrentPluginMetadataSnapshot,
  getCurrentPluginMetadataSnapshotState,
  setCurrentPluginMetadataSnapshotState,
} from "../plugins/current-plugin-metadata-state.js";
import { hashStableJson } from "../plugins/installed-plugin-index-hash.js";
import { PluginRuntimeApplicationError, getPluginRuntimeGeneration } from "../plugins/lifecycle.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { capturePluginGenerationArtifact } from "../plugins/plugin-generation-artifact.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createServiceRegistration } from "../plugins/services.test-support.js";
import {
  captureGatewayRootWorkAdmissionContinuationScope,
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  getSkillsSnapshotVersion,
  resetSkillsRefreshStateForTest,
} from "../skills/runtime/refresh-state.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { withEnvAsync } from "../test-utils/env.js";
import { diffConfigPaths, diffGatewayReloadPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  type ChannelKind,
  isNoopGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
  resolveConfigReloadMetadata,
} from "./config-reload-plan.js";
import type {
  GatewayConfigReloadTransactionOwnership,
  GatewayReloadPlan,
} from "./config-reload.js";
import { registerPluginServiceReloadTests } from "./config-reload.services.test-support.js";
import {
  closeTestConfigReloaders,
  createConfigReloadTestClock,
  createReloaderHarness,
  createWriteReloaderHarness,
  flushReload,
  flushWatcherChange,
  getOnlyHotReloadCall,
  getOnlyRestartCall,
  makeGatewayPortConfig,
  makeSnapshot,
  makeWrite,
  makeZeroDebounceHookSnapshot,
  makeZeroDebounceHookWrite,
  prepareConfigReloadTest,
  startGatewayConfigReloader,
  waitForReloadState,
} from "./config-reload.test-support.js";
import { installWatcherMock } from "./config-reload.watcher.test-support.js";
import { commitGatewayConfigWrite } from "./server-methods/config-write-flow.js";
import { GatewayConfigReloadSupersededError } from "./server-reload-contracts.js";
import { createTerminalLaunchPolicy } from "./terminal/launch.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(closeTestConfigReloaders);

const configAuditMocks = vi.hoisted(() => ({
  append: vi.fn(),
  readLatestSnapshot: vi.fn(),
  upsertSnapshot: vi.fn(),
}));

vi.mock("../config/io.audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/io.audit.js")>();
  return {
    ...actual,
    appendConfigAuditRecord: configAuditMocks.append,
  };
});

vi.mock("../config/config-journal-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config-journal-snapshot.js")>();
  return {
    ...actual,
    readLatestConfigSnapshotAuditRecordAsync: configAuditMocks.readLatestSnapshot,
    upsertConfigSnapshotAuditRecordAsync: configAuditMocks.upsertSnapshot,
  };
});

beforeEach((context) => {
  prepareConfigReloadTest(context);
  configAuditMocks.append.mockReset();
  configAuditMocks.readLatestSnapshot.mockReset().mockReturnValue(null);
  configAuditMocks.upsertSnapshot.mockReset();
});

describe("diffConfigPaths", () => {
  it("does not report unchanged arrays of objects as changed", () => {
    const prev = {
      bindings: [{ agentId: "main", match: { channel: "slack", accountId: "default" } }],
    };
    const next = {
      bindings: [{ agentId: "main", match: { channel: "slack", accountId: "default" } }],
    };
    expect(diffConfigPaths(prev, next)).toStrictEqual([]);
  });

  it.each([
    { prev: {}, next: { mcp: { apps: { enabled: true } } } },
    { prev: { mcp: { apps: { enabled: true } } }, next: {} },
  ])("preserves the Apps restart boundary for whole MCP changes", ({ prev, next }) => {
    const changedPaths = diffGatewayReloadPaths(prev, next, listConfigReloadRefinementPrefixes());
    const plan = buildGatewayReloadPlan(changedPaths);
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toEqual(changedPaths);
  });

  it("reloads only changed Talk speech owners", () => {
    const configure = (provider: string, model?: string) => ({
      talk: { providers: { [provider]: { model } } },
    });
    for (const [prev, next, reload] of [
      [{}, configure("first"), true],
      [configure("first"), configure("second"), true],
      [configure("first", "before"), configure("first", "after"), false],
    ] as const) {
      expect(
        buildGatewayReloadPlan(
          diffGatewayReloadPaths(prev, next, listConfigReloadRefinementPrefixes()),
        ).reloadPlugins,
      ).toBe(reload);
    }
  });
});

describe("buildGatewayReloadPlan", () => {
  const emptyRegistry = createTestRegistry([]);
  registerPluginServiceReloadTests();
  it("selects only attached service owners for their declared config and preserves unknown restart policy", () => {
    const serviceRegistry = createTestRegistry([]);
    serviceRegistry.services.push(
      createServiceRegistration(
        {
          id: " exporter ",
          reload: { configPrefixes: ["diagnostics.otel", "diagnostics.enabled"] },
          start() {},
        },
        { pluginId: "exporter" },
      ),
    );
    setActivePluginRegistry(serviceRegistry);
    const plan = buildGatewayReloadPlan(["diagnostics.otel.endpoint", "diagnostics.enabled"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartServices).toEqual(new Set(["exporter"]));
    expect(plan.reloadPlugins).toBe(false);
    expect(plan.restartChannels.size).toBe(0);
    expect(resolveConfigReloadMetadata("diagnostics.otel.endpoint")).toEqual({ kind: "hot" });
    expect(buildGatewayReloadPlan(["diagnostics.futurePolicy"]).restartGateway).toBe(true);
    setActivePluginRegistry(emptyRegistry);
    expect(buildGatewayReloadPlan(["diagnostics.otel.endpoint"]).restartGateway).toBe(true);
  });
  const telegramPlugin: ChannelPlugin = {
    ...createChannelTestPluginBase({
      id: "telegram",
      label: "Telegram",
      config: { listAccountIds: () => [] },
    }),
    reload: { configPrefixes: ["channels.telegram"] },
  };
  const whatsappPlugin: ChannelPlugin = {
    ...createChannelTestPluginBase({
      id: "whatsapp",
      label: "WhatsApp",
      config: { listAccountIds: () => [] },
    }),
    reload: {
      configPrefixes: ["web", "channels.whatsapp.accounts", "channels.whatsapp.selfChatMode"],
      noopPrefixes: ["channels.whatsapp"],
    },
  };
  const mattermostPlugin: ChannelPlugin = {
    ...createChannelTestPluginBase({
      id: "mattermost",
      label: "Mattermost",
      config: {
        listAccountIds: (cfg) => Object.keys(cfg.channels?.mattermost?.accounts ?? {}),
      },
    }),
    reload: { configPrefixes: ["channels.mattermost"], accountScopedRestart: true },
  };
  const registry = createTestRegistry([
    { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
    { pluginId: "mattermost", plugin: mattermostPlugin, source: "test" },
  ]);
  it.each([
    { prefix: "gateway", path: "gateway.port", kind: "restart", services: [] },
    { prefix: "logging", path: "logging.level", kind: "none", services: [] },
    {
      prefix: "plugins",
      path: "plugins.entries.exporter.enabled",
      kind: "hot",
      services: ["exporter"],
    },
    {
      prefix: "channels.whatsapp.exporter",
      path: "channels.whatsapp.exporter.enabled",
      kind: "hot",
      services: ["exporter"],
    },
  ] as const)("preserves explicit policy precedence for service $prefix", (entry) => {
    const { prefix, path: changedPath, kind, services } = entry;
    const serviceRegistry = createTestRegistry([
      { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
    ]);
    serviceRegistry.services.push(
      createServiceRegistration(
        { id: "exporter", reload: { configPrefixes: [prefix] }, start() {} },
        { pluginId: "exporter" },
      ),
    );
    setActivePluginRegistry(serviceRegistry);
    expect(resolveConfigReloadMetadata(changedPath)).toEqual({ kind });
    const plan = buildGatewayReloadPlan([changedPath]);
    expect(plan.restartGateway).toBe(kind === "restart");
    expect(plan.restartServices).toEqual(new Set(services));
    if (prefix === "plugins") {
      expect(plan.reloadPlugins).toBe(true);
      expect(plan.disposeMcpRuntimes).toBe(true);
    }
    setActivePluginRegistry(emptyRegistry);
  });
  it.each([
    { prefix: "messages", allChannelsLive: false, globalNoop: false },
    { prefix: "messages.inbound", allChannelsLive: true, globalNoop: false },
    { prefix: "messages.inbound.debounceMs", allChannelsLive: false, globalNoop: true },
  ])(
    "composes service $prefix with shared policy: all live=$allChannelsLive global noop=$globalNoop",
    ({ prefix, allChannelsLive, globalNoop }) => {
      const serviceRegistry = createTestRegistry([
        {
          pluginId: "telegram",
          plugin: { ...telegramPlugin, reload: { noopPrefixes: ["messages.inbound"] } },
          source: "test",
        },
        {
          pluginId: "whatsapp",
          plugin: allChannelsLive
            ? { ...whatsappPlugin, reload: { noopPrefixes: ["messages.inbound"] } }
            : whatsappPlugin,
          source: "test",
        },
      ]);
      serviceRegistry.services.push(
        createServiceRegistration(
          { id: "exporter", reload: { configPrefixes: [prefix] }, start() {} },
          { pluginId: "exporter" },
        ),
      );
      if (globalNoop) {
        serviceRegistry.reloads.push({
          pluginId: "policy-owner",
          pluginName: "Policy owner",
          source: "test",
          registration: { noopPrefixes: ["messages.inbound.debounceMs"] },
        });
      }
      setActivePluginRegistry(serviceRegistry);
      const plan = buildGatewayReloadPlan(["messages.inbound.debounceMs"]);
      expect(plan.restartGateway).toBe(false);
      expect(plan.restartServices).toEqual(new Set(globalNoop ? [] : ["exporter"]));
      expect(plan.restartChannels).toEqual(
        new Set(allChannelsLive || globalNoop ? [] : ["whatsapp"]),
      );
      setActivePluginRegistry(emptyRegistry);
    },
  );
  registry.reloads = [
    {
      pluginId: "browser",
      pluginName: "Browser",
      registration: { restartPrefixes: ["browser"], hotPrefixes: ["browser.profiles"] },
      source: "test",
    },
    {
      pluginId: "canvas",
      pluginName: "Canvas",
      registration: { restartPrefixes: ["plugins.entries.canvas"] },
      source: "test",
    },
    {
      pluginId: "codex",
      pluginName: "Codex",
      registration: { noopPrefixes: ["plugins.entries.codex.config.codexPlugins"] },
      source: "test",
    },
  ];

  beforeEach(() => {
    setActivePluginRegistry(registry);
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(emptyRegistry);
  });

  it.each(["unloaded", "undeclared"] as const)(
    "replaces the plugin generation for %s channel settings without restarting the Gateway",
    (state) => {
      const channelRegistry = createTestRegistry(
        state === "undeclared"
          ? [
              {
                pluginId: "chat-owner",
                source: "test",
                plugin: { ...telegramPlugin, reload: undefined },
              },
            ]
          : [],
      );
      if (state !== "unloaded") {
        channelRegistry.plugins.push(
          createPluginRecord({
            id: "chat-owner",
            source: "test",
            origin: "bundled",
            enabled: true,
            configSchema: false,
            channelIds: ["telegram"],
          }),
        );
      }
      setActivePluginRegistry(channelRegistry);
      const plan = buildGatewayReloadPlan(["channels.telegram.enabled"]);
      expect(plan.restartGateway).toBe(false);
      expect(plan.reloadPlugins).toBe(true);
      expect(plan.reloadPluginIds).toEqual(
        state === "unloaded" ? undefined : new Set(["chat-owner"]),
      );
      expect(plan.hotReasons).toEqual(["channels.telegram.enabled"]);
      expect(resolveConfigReloadMetadata("channels.telegram.enabled").kind).toBe("hot");
    },
  );

  it.each([
    { policy: "hotPrefixes", prefix: "channels" },
    { policy: "noopPrefixes", prefix: "channels.telegram" },
    { policy: "restartPrefixes", prefix: "channels.telegram" },
  ])(
    "preserves declared $policy for $prefix during an unrelated plugin reload",
    ({ policy, prefix }) => {
      const channelRegistry = createTestRegistry();
      channelRegistry.plugins.push(
        createPluginRecord({
          id: "chat-owner",
          source: "test",
          origin: "bundled",
          enabled: true,
          configSchema: false,
          channelIds: ["telegram"],
        }),
      );
      channelRegistry.reloads.push({
        pluginId: "chat-owner",
        pluginName: "Chat owner",
        source: "test",
        registration: { [policy]: [prefix] },
      });
      setActivePluginRegistry(channelRegistry);
      const plan = buildGatewayReloadPlan([
        "channels.telegram.enabled",
        "plugins.entries.other.config.value",
      ]);
      expect(plan.reloadPlugins).toBe(true);
      expect(plan.reloadPluginIds).toBeUndefined();
      expect(plan.restartGateway).toBe(policy === "restartPrefixes");
    },
  );

  it("treats plugin install timestamp-only changes as no-ops", () => {
    const paths = [
      "plugins.installs.lossless-claw.resolvedAt",
      "plugins.installs.lossless-claw.installedAt",
    ];
    const plan = buildGatewayReloadPlan(paths);

    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toEqual(paths);
    for (const path of paths) {
      expect(resolveConfigReloadMetadata(path).kind).toBe("none");
    }
  });

  it.each<[string, boolean]>([
    ["channels.mattermost.accounts.very-long-account-name.groupPolicy", true],
    ["channels.mattermost.accounts.locked.groupPolicy", false],
    ["channels.mattermost.accounts..groupPolicy", false],
  ])("honors per-account dynamic policy paths: %s", (path, dynamic) => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: mattermostPlugin.id,
          source: "test",
          plugin: {
            ...mattermostPlugin,
            reload: {
              configPrefixes: [
                "channels.mattermost",
                "channels.mattermost.accounts.very-long-account-name",
                "channels.mattermost.accounts.locked.groupPolicy",
              ],
              noopPrefixes: [
                "channels.mattermost.accounts.*.groupPolicy",
                "channels.mattermost.accounts.*.guilds",
              ],
            },
          },
        },
      ]),
    );
    const plan = buildGatewayReloadPlan([path]);
    expect(isNoopGatewayReloadPlan(plan)).toBe(dynamic);
    expect(plan.restartChannels).toEqual(new Set(dynamic ? [] : ["mattermost"]));
  });

  it("shared policy refresh subsumes scoped restarts", () => {
    const path = "messages.inbound";
    const plan = buildGatewayReloadPlan(["channels.mattermost.accounts.alpha.enabled", path]);
    expect(plan.restartChannels).toEqual(new Set(["telegram", "whatsapp", "mattermost"]));
    expect(plan.restartChannelAccounts).toEqual(new Map());
    expect(buildGatewayReloadPlan(["agents.defaults.model"]).restartChannels).toEqual(new Set());
  });

  it("applies each channel's narrowest shared policy independently", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: {
            ...telegramPlugin,
            reload: {
              configPrefixes: ["messages.inbound.byChannel.telegram"],
              noopPrefixes: ["messages.inbound"],
            },
          },
          source: "test",
        },
        {
          pluginId: "whatsapp",
          plugin: {
            ...whatsappPlugin,
            reload: { configPrefixes: [], noopPrefixes: ["messages"] },
          },
          source: "test",
        },
        { pluginId: "mattermost", plugin: mattermostPlugin, source: "test" },
      ]),
    );
    expect(buildGatewayReloadPlan(["messages.inbound.debounceMs"]).restartChannels).toEqual(
      new Set(["mattermost"]),
    );
    expect(buildGatewayReloadPlan(["messages.inbound.byChannel.telegram"]).restartChannels).toEqual(
      new Set(["telegram", "mattermost"]),
    );
    const paths = diffGatewayReloadPaths(
      {},
      { messages: { inbound: { debounceMs: 20, byChannel: { telegram: 10 } } } },
      listConfigReloadRefinementPrefixes(),
    );
    expect(buildGatewayReloadPlan(paths).restartChannels).toEqual(
      new Set(["telegram", "mattermost"]),
    );
  });

  const mattermostAccountConfig = {
    channels: {
      mattermost: {
        accounts: {
          alpha: { enabled: true },
          beta: { enabled: true },
        },
      },
    },
  } as OpenClawConfig;

  it.each([
    {
      label: "targets changed named accounts",
      paths: [
        "channels.mattermost.accounts.alpha.enabled",
        "channels.mattermost.accounts.beta.commands",
      ],
      expectedChannels: new Set<ChannelKind>(),
      expectedAccounts: new Map<ChannelKind, Set<string>>([
        ["mattermost", new Set(["alpha", "beta"])],
      ]),
    },
    {
      label: "promotes accounts.default changes",
      paths: ["channels.mattermost.accounts.default.commands"],
      expectedChannels: new Set<ChannelKind>(["mattermost"]),
      expectedAccounts: new Map<ChannelKind, Set<string>>(),
    },
    {
      label: "lets an unlisted account replace earlier scoped targets",
      paths: [
        "channels.mattermost.accounts.alpha.enabled",
        "channels.mattermost.accounts.removed.enabled",
      ],
      expectedChannels: new Set<ChannelKind>(["mattermost"]),
      expectedAccounts: new Map<ChannelKind, Set<string>>(),
    },
    {
      label: "lets a mixed global change replace scoped targets",
      paths: ["channels.mattermost.accounts.alpha.enabled", "channels.mattermost.botToken"],
      expectedChannels: new Set<ChannelKind>(["mattermost"]),
      expectedAccounts: new Map<ChannelKind, Set<string>>(),
    },
  ])("$label", ({ paths, expectedChannels, expectedAccounts }) => {
    const plan = buildGatewayReloadPlan(paths, { candidateConfig: mattermostAccountConfig });

    expect(plan.restartChannels).toEqual(expectedChannels);
    expect(plan.restartChannelAccounts).toEqual(expectedAccounts);
    expect(isNoopGatewayReloadPlan(plan)).toBe(false);
  });

  it.each([
    {
      label: "inspects unresolved account secrets",
      inspection: "available",
      resolves: false,
      scoped: true,
    },
    {
      label: "promotes failed inspection without falling back to resolution",
      inspection: "throws",
      resolves: true,
      scoped: false,
    },
    {
      label: "resolves accounts when inspection is unavailable",
      inspection: "absent",
      resolves: true,
      scoped: true,
    },
  ])("$label", ({ inspection, resolves, scoped }) => {
    const plugin: ChannelPlugin = {
      ...mattermostPlugin,
      config: {
        ...mattermostPlugin.config,
        resolveAccount: () => {
          if (!resolves) {
            throw new Error("SecretRef has not been activated");
          }
          return {};
        },
        ...(inspection === "absent"
          ? {}
          : {
              inspectAccount: () => {
                if (inspection === "throws") {
                  throw new Error("Account cannot be inspected");
                }
                return { configured: true, botTokenStatus: "configured_unavailable" };
              },
            }),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "mattermost", plugin, source: "test" }]),
    );
    const candidateConfig = {
      channels: {
        mattermost: {
          accounts: {
            alpha: { botToken: { source: "env", provider: "default", id: "BOT_TOKEN" } },
            beta: { enabled: true },
          },
        },
      },
    } as OpenClawConfig;
    const plan = buildGatewayReloadPlan(["channels.mattermost.accounts.alpha.botToken"], {
      candidateConfig,
    });
    expect(plan.restartChannels).toEqual(new Set(scoped ? [] : ["mattermost"]));
    expect(plan.restartChannelAccounts).toEqual(
      new Map(scoped ? [["mattermost", new Set(["alpha"])]] : []),
    );
  });
});

describe("startGatewayConfigReloader include files", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    await closeTestConfigReloaders();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reloads when an included config file changes", async () => {
    const rootDir = await realpath(
      await mkdtemp(nodePath.join(tmpdir(), "openclaw-config-reload-")),
    );
    const configPath = nodePath.join(rootDir, "openclaw.json5");
    const includePath = nodePath.join(rootDir, "hooks.json5");
    const includeLinkPath = nodePath.join(rootDir, "hooks-link.json5");
    const nestedIncludePath = nodePath.join(rootDir, "hooks-enabled.json5");
    await writeFile(
      configPath,
      `${JSON.stringify({ gateway: { reload: { mode: "hybrid" } }, hooks: { $include: "./hooks-link.json5" } }, null, 2)}\n`,
    );
    await writeFile(
      includePath,
      `${JSON.stringify({ $include: "./hooks-enabled.json5" }, null, 2)}\n`,
    );
    await writeFile(nestedIncludePath, `${JSON.stringify({ enabled: true }, null, 2)}\n`);
    await symlink(includePath, includeLinkPath);
    const configIo = createConfigIO({
      configPath,
      env: { HOME: rootDir, OPENCLAW_STATE_DIR: rootDir },
      homedir: () => rootDir,
      observe: false,
      pluginValidation: "skip",
      logger: { error: vi.fn(), warn: vi.fn() },
    });
    const initialSnapshot = await configIo.readConfigFileSnapshot();
    expect(initialSnapshot.valid, JSON.stringify(initialSnapshot.issues)).toBe(true);
    const onHotReload = vi.fn(async () => "applied" as const);
    const watcher = installWatcherMock();
    const applied = createDeferred<OpenClawConfig>();
    const { promise: watcherReady, resolve: signalWatcherReady } = createDeferred();
    const reloader = startGatewayConfigReloader({
      initialConfig: initialSnapshot.config,
      initialCompareConfig: initialSnapshot.sourceConfig,
      initialSnapshotRawHash: hashConfigRaw(initialSnapshot.raw),
      initialAuthoredConfig: initialSnapshot.parsed,
      initialIncludedPaths: initialSnapshot.includedPaths,
      initialSnapshotValid: initialSnapshot.valid,
      initialSnapshotIssues: initialSnapshot.issues,
      testDebounceMs: 0,
      onWatcherReady: signalWatcherReady,
      readSnapshot: async () => await configIo.readConfigFileSnapshot(),
      initialPluginInstallRecords: {},
      readPluginInstallRecords: async () => ({}),
      onNoopConfigCommit: async () => {},
      onHotReload,
      onConfigApplied: (_plan, config) => applied.resolve(config),
      onRestart: vi.fn(),
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      watchPath: configPath,
    });
    await reloader.ready;

    try {
      expect(initialSnapshot.includedPaths).toEqual(
        [includeLinkPath, includePath, nestedIncludePath].toSorted(),
      );
      watcher.emit("ready");
      await watcherReady;
      await writeFile(nestedIncludePath, `${JSON.stringify({ enabled: false }, null, 2)}\n`);
      watcher.emit("change", nestedIncludePath);
      await vi.advanceTimersByTimeAsync(0);
      await expect(applied.promise).resolves.toMatchObject({ hooks: { enabled: false } });
      expect(onHotReload).toHaveBeenCalledOnce();
    } finally {
      await reloader.stop();
      await rm(rootDir, { force: true, recursive: true });
    }
  });
});

function getOnlyPromoteSnapshotCall(promoteSnapshot: {
  mock: { calls: Array<readonly [ConfigFileSnapshot, string]> };
}): readonly [ConfigFileSnapshot, string] {
  expect(promoteSnapshot).toHaveBeenCalledTimes(1);
  const call = promoteSnapshot.mock.calls[0];
  if (!call) {
    throw new Error("expected one promote snapshot call");
  }
  return call;
}

describe("startGatewayConfigReloader", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await closeTestConfigReloaders();
    clearCurrentPluginMetadataSnapshot();
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["off"] as const)(
    "finishes a committed plugin reload after its invoker closes in %s mode",
    async (mode) => {
      let invokerOpen = true;
      const config: OpenClawConfig = { gateway: { reload: { mode } } };
      const runtime = { operationId: "runtime-owner", generation: 9, pluginIds: ["notes"] };
      const transactionEntered = vi.fn();
      const runTransaction = async <T>(run: () => Promise<T>): Promise<T> => {
        transactionEntered();
        return await run();
      };
      const harness = createReloaderHarness(
        async () =>
          makeSnapshot({
            config,
            hash: "same",
          }),
        {
          initialConfig: config,
          initialCompareConfig: config,
          runTransaction,
          onHotReload: async (plan, nextConfig, ownership) => {
            ownership.markRuntimeCommitted(nextConfig, plan);
            invokerOpen = false;
            await Promise.resolve();
            ownership.assertInvokerOwned?.();
            return { status: "applied", runtime };
          },
        },
      );
      await harness.reloader.ready;
      expect(
        await harness.reloader.applyPluginLifecycleChange({
          config,
          pluginIds: ["notes"],
          reason: "reload",
          assertInvokerOwned: () => {
            if (!invokerOpen) {
              throw new Error("plugin invoker closed");
            }
          },
        }),
      ).toBe(runtime);
      expect(harness.onHotReload).toHaveBeenCalledOnce();
      expect(harness.onHotReload.mock.calls[0]?.[0]).toMatchObject({
        reloadPlugins: true,
        restartGateway: false,
        pluginLifecycle: { pluginIds: ["notes"], reason: "reload" },
      });
      expect(transactionEntered).not.toHaveBeenCalled();
      expect(harness.onRestart).not.toHaveBeenCalled();
      await harness.reloader.stop();
    },
  );

  it.each(["queue", "snapshot"] as const)(
    "rejects a plugin invoker closed while awaiting %s without blocking later reloads",
    async (boundary) => {
      const config: OpenClawConfig = { gateway: { reload: { mode: "off" } } };
      const runtime = { operationId: "runtime-owner", generation: 9, pluginIds: ["notes"] };
      const entered = createDeferred();
      const release = createDeferred();
      let waiting = true;
      let invokerOpen = true;
      const failure = new Error("plugin invoker closed");
      const pause = async () => {
        waiting = false;
        entered.resolve();
        await release.promise;
      };
      const readSnapshot = vi.fn(async () => {
        if (boundary === "snapshot" && waiting) {
          await pause();
        }
        return makeSnapshot({
          config,
          hash: "same",
        });
      });
      const harness = createReloaderHarness(readSnapshot, {
        initialConfig: config,
        onHotReload: async (plan, nextConfig, ownership) => {
          if (boundary === "queue" && waiting) {
            await pause();
          }
          ownership.markRuntimeCommitted(nextConfig, plan);
          return { status: "applied", runtime };
        },
      });
      await harness.reloader.ready;
      const request = { config, pluginIds: ["notes"], reason: "reload" as const };
      const first =
        boundary === "queue" ? harness.reloader.applyPluginLifecycleChange(request) : undefined;
      const pending = harness.reloader
        .applyPluginLifecycleChange({
          ...request,
          assertInvokerOwned: () => {
            if (!invokerOpen) {
              throw failure;
            }
          },
        })
        .catch((error: unknown) => error);
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("plugin reload completed before its pause");
          }),
        ]);
        invokerOpen = false;
        release.resolve();
        expect(await pending).toMatchObject({ message: expect.stringContaining(failure.message) });
        if (first) {
          await expect(first).resolves.toBe(runtime);
        }
        expect(readSnapshot).toHaveBeenCalledOnce();
        expect(harness.onHotReload).toHaveBeenCalledTimes(boundary === "queue" ? 1 : 0);
        await expect(harness.reloader.applyPluginLifecycleChange(request)).resolves.toBe(runtime);
        expect(harness.onRestart).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.allSettled([first, pending]);
        await harness.reloader.stop();
      }
    },
  );

  it.each(["current", "stale"] as const)(
    "checks explicit plugin reload against %s authored config before applying defaults",
    async (source) => {
      const configRoot = tempDirs.make("openclaw-plugin-reload-source-");
      const configPath = nodePath.join(configRoot, "openclaw.json");
      await writeFile(
        configPath,
        JSON.stringify({ gateway: { reload: { mode: "off" } }, plugins: { enabled: false } }),
      );
      const snapshot = await createConfigIO({
        configPath,
        env: { ...process.env, OPENCLAW_STATE_DIR: configRoot },
      }).readConfigFileSnapshot();
      expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
      expect(snapshot.sourceConfig.commands).toBeUndefined();
      expect(snapshot.config.commands).toEqual({
        native: "auto",
        nativeSkills: "auto",
        restart: true,
      });
      const runtime = { operationId: "source-owner", generation: 9, pluginIds: ["notes"] };
      const harness = createReloaderHarness(async () => snapshot, {
        initialConfig: snapshot.config,
        initialCompareConfig: snapshot.sourceConfig,
        onHotReload: async (plan, nextConfig, ownership) => {
          ownership.markRuntimeCommitted(nextConfig, plan);
          return { status: "applied", runtime };
        },
      });
      await harness.reloader.ready;
      try {
        const application = harness.reloader.applyPluginLifecycleChange({
          config:
            source === "current"
              ? snapshot.sourceConfig
              : { ...snapshot.sourceConfig, plugins: { enabled: true } },
          pluginIds: ["notes"],
          reason: "reload",
        });
        if (source === "current") {
          await expect(application).resolves.toBe(runtime);
          expect(harness.onHotReload).toHaveBeenCalledOnce();
          expect(harness.onHotReload.mock.calls[0]?.[1]).toBe(snapshot.config);
          expect(harness.onHotReload.mock.calls[0]?.[3]).toBe(snapshot.sourceConfig);
        } else {
          await expect(application).rejects.toMatchObject({
            details: { phase: "prepare", committed: false },
            cause: expect.any(GatewayConfigReloadSupersededError),
          });
          expect(harness.onHotReload).not.toHaveBeenCalled();
        }
        expect(harness.onRestart).not.toHaveBeenCalled();
      } finally {
        await harness.reloader.stop();
      }
    },
  );

  it.each([
    { storage: "root", superseded: false },
    { storage: "include", superseded: true },
  ] as const)(
    "applies only its committed plugin config ($storage, superseded=$superseded)",
    async ({ storage, superseded }) => {
      const configRoot = await realpath(tempDirs.make("openclaw-plugin-write-receipt-"));
      const configPath = nodePath.join(configRoot, "openclaw.json");
      const includePath = nodePath.join(configRoot, "plugins.json5");
      await writeFile(includePath, JSON.stringify({ enabled: false }));
      await writeFile(
        configPath,
        JSON.stringify({
          gateway: { reload: { mode: "off" } },
          agents: { defaults: { models: { "openai/gpt-5.6-luna": {} } } },
          plugins: storage === "include" ? { $include: "./plugins.json5" } : { enabled: false },
        }),
      );
      const io = createConfigIO({
        configPath,
        env: {
          ...process.env,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: configRoot,
        },
      });
      const prepared = await io.readConfigFileSnapshotForWrite();
      expect(prepared.snapshot.valid, JSON.stringify(prepared.snapshot.issues)).toBe(true);
      const config = {
        ...prepared.snapshot.sourceConfig,
        plugins: { ...prepared.snapshot.sourceConfig.plugins, allow: [] },
      };
      const write = await replaceConfigFile({
        nextConfig: config,
        snapshot: prepared.snapshot,
        writeOptions: prepared.writeOptions,
        io,
      });
      if (storage === "root") {
        expect(write.nextConfig.meta?.lastTouchedVersion).toBeTypeOf("string");
        expect(write.nextConfig.agents?.defaults?.modelPolicy?.allow).toEqual([
          "openai/gpt-5.6-luna",
        ]);
        expect(config.meta?.lastTouchedVersion).toBeUndefined();
      }
      if (superseded) {
        await writeFile(
          storage === "include" ? includePath : configPath,
          storage === "include"
            ? JSON.stringify({ enabled: false, allow: ["another-plugin"] })
            : JSON.stringify(write.nextConfig, null, 4),
        );
      }
      const current = await io.readConfigFileSnapshot();
      expect(current.valid, JSON.stringify(current.issues)).toBe(true);
      if (superseded) {
        expect(current.hash).not.toBe(write.persistedHash);
      } else {
        expect(current.hash).toBe(write.persistedHash);
      }
      const runtime = { operationId: "written-config", generation: 9, pluginIds: ["notes"] };
      const harness = createReloaderHarness(async () => current, {
        initialConfig: prepared.snapshot.config,
        initialCompareConfig: prepared.snapshot.sourceConfig,
        onHotReload: async (plan, nextConfig, ownership) => {
          ownership.markRuntimeCommitted(nextConfig, plan);
          return { status: "applied", runtime };
        },
      });
      await harness.reloader.ready;
      try {
        const application = harness.reloader.applyPluginLifecycleChange({
          config,
          write,
          pluginIds: ["notes"],
          reason: "disable",
        });
        if (superseded) {
          await expect(application).rejects.toMatchObject({
            details: { phase: "prepare", committed: false },
            cause: expect.any(GatewayConfigReloadSupersededError),
          });
          expect(harness.onHotReload).not.toHaveBeenCalled();
        } else {
          await expect(application).resolves.toBe(runtime);
          expect(harness.onHotReload).toHaveBeenCalledOnce();
          expect(harness.onHotReload.mock.calls[0]?.[3]).toBe(current.sourceConfig);
        }
        expect(harness.onRestart).not.toHaveBeenCalled();
      } finally {
        await harness.reloader.stop();
      }
    },
  );

  it.each(["source", "hash"] as const)(
    "rejects a writer receipt missing its %s before plugin runtime application",
    async (missing) => {
      const config: OpenClawConfig = { gateway: { reload: { mode: "off" } } };
      const runtime = { operationId: "runtime-owner", generation: 9, pluginIds: ["notes"] };
      const harness = createReloaderHarness(
        async () =>
          makeSnapshot({
            config,
            hash: "same",
          }),
        {
          initialConfig: config,
          initialCompareConfig: config,
          onHotReload: async (plan, nextConfig, ownership) => {
            ownership.markRuntimeCommitted(nextConfig, plan);
            return { status: "applied", runtime };
          },
        },
      );
      await harness.reloader.ready;
      try {
        await expect(
          harness.reloader.applyPluginLifecycleChange({
            config,
            write:
              missing === "source"
                ? { persistedHash: "same" }
                : { persistedHash: null, persistedSourceConfig: config },
            pluginIds: ["notes"],
            reason: "disable",
          }),
        ).rejects.toMatchObject({
          details: { phase: "prepare", committed: false },
          cause: expect.any(GatewayConfigReloadSupersededError),
        });
        expect(harness.onHotReload).not.toHaveBeenCalled();
        expect(harness.onRestart).not.toHaveBeenCalled();
      } finally {
        await harness.reloader.stop();
      }
    },
  );

  it.each([
    { boundary: "pending", mismatch: "hash" },
    { boundary: "watcher", mismatch: "source" },
    { boundary: "watcher-with-pending", mismatch: "hash" },
  ] as const)(
    "supersedes a $boundary write with a stale $mismatch before applying an explicit reload",
    async ({ boundary, mismatch }) => {
      const initialConfig: OpenClawConfig = { gateway: { reload: {} } };
      const staleConfig: OpenClawConfig = {
        ...initialConfig,
        hooks: { enabled: true, path: "/stale" },
      };
      const config: OpenClawConfig = {
        ...initialConfig,
        hooks: { enabled: true, path: "/current" },
      };
      const snapshot = makeSnapshot({
        config,
        hash: "current",
      });
      const runtime = { operationId: "current-source", generation: 9, pluginIds: ["notes"] };
      const application = createRuntimeConfigWriteApplication();
      const settled = vi.fn();
      void application.result.then(settled);
      let currentApplication: ReturnType<typeof createRuntimeConfigWriteApplication> | undefined;
      const harness = createReloaderHarness(async () => snapshot, {
        initialConfig,
        onHotReload: async (plan, nextConfig, ownership) => {
          ownership.markRuntimeCommitted(nextConfig, plan);
          return { status: "applied", runtime };
        },
      });
      await harness.reloader.ready;
      try {
        harness.emitWrite(
          attachRuntimeConfigWriteApplication(
            {
              ...makeZeroDebounceHookWrite(mismatch === "hash" ? "stale" : "current"),
              snapshot: makeSnapshot({
                sourceConfig: mismatch === "source" ? staleConfig : config,
                config: staleConfig,
                hash: mismatch === "hash" ? "stale" : "current",
              }),
              sourceConfig: mismatch === "source" ? staleConfig : config,
              runtimeConfig: staleConfig,
            },
            application,
          ),
        );
        if (boundary !== "pending") {
          harness.watcher.emit("change");
        }
        if (boundary === "watcher-with-pending") {
          currentApplication = createRuntimeConfigWriteApplication();
          harness.emitWrite(
            attachRuntimeConfigWriteApplication(
              {
                ...makeZeroDebounceHookWrite("current"),
                snapshot,
                sourceConfig: config,
                runtimeConfig: config,
              },
              currentApplication,
            ),
          );
        }
        // Neither the write timer nor the watcher reread has run yet.
        await expect(
          harness.reloader.applyPluginLifecycleChange({
            config,
            pluginIds: ["notes"],
            reason: "reload",
          }),
        ).resolves.toBe(runtime);
        expect(harness.onHotReload).toHaveBeenCalledOnce();
        expect(harness.onHotReload.mock.calls[0]?.[1]).toBe(config);
        expect(harness.onHotReload.mock.calls[0]?.[3]).toBe(config);
        expect(settled).toHaveBeenCalledExactlyOnceWith("superseded");
        if (currentApplication) {
          await expect(currentApplication.result).resolves.toBe("applied");
        }
        await flushWatcherChange(harness);
        expect(harness.onHotReload).toHaveBeenCalledOnce();
        expect(harness.onRestart).not.toHaveBeenCalled();
      } finally {
        await harness.reloader.stop();
      }
    },
  );

  it.each([
    { boundary: "activation", scenario: "committed" },
    { boundary: "activation", scenario: "failed-cleanup" },
    { boundary: "snapshot", scenario: "same-source" },
    { boundary: "snapshot", scenario: "pending-write" },
  ] as const)(
    "reconciles an explicit watcher observation without replaying ($boundary, $scenario)",
    async ({ boundary, scenario }) => {
      const config: OpenClawConfig = {
        gateway: { reload: {} },
        plugins: { entries: { notes: { enabled: false } } },
      };
      const enabledConfig: OpenClawConfig = {
        ...config,
        plugins: { entries: { notes: { enabled: true } } },
      };
      const writeNotification = makeWrite(config, "same", {
        afterWrite: { mode: "none", reason: "plugin lifecycle applies runtime" },
      });
      const newerApplication = createRuntimeConfigWriteApplication();
      const operationIds: string[] = [];
      let applying = false;
      let reads = 0;
      const harness = createReloaderHarness(
        async () => {
          if (applying && ++reads === 1 && boundary === "snapshot") {
            if (scenario === "pending-write") {
              harness.emitWrite(
                attachRuntimeConfigWriteApplication(writeNotification, newerApplication),
              );
            } else {
              harness.watcher.emit("change");
            }
          }
          return makeSnapshot({ config, hash: "same" });
        },
        {
          initialConfig: boundary === "snapshot" ? enabledConfig : config,
          onHotReload: async (plan, nextConfig, ownership) => {
            if (!plan.pluginLifecycle) {
              throw new Error("Missing plugin operation owner");
            }
            const operationId = plan.pluginLifecycle.operationId;
            operationIds.push(operationId);
            if (boundary === "activation") {
              if (scenario === "committed") {
                ownership.markRuntimeCommitted(nextConfig, plan);
              }
              harness.watcher.emit("change");
              const superseded = new GatewayConfigReloadSupersededError();
              throw new PluginRuntimeApplicationError(
                "Plugin operation superseded",
                {
                  operationId,
                  generation: 1,
                  pluginIds: ["notes"],
                  phase: "activate",
                  committed: scenario === "committed",
                },
                {
                  cause:
                    scenario === "failed-cleanup"
                      ? new AggregateError([superseded, new Error("cleanup failed")])
                      : superseded,
                },
              );
            }
            ownership.markRuntimeCommitted(nextConfig, plan);
            return {
              status: "applied",
              runtime: { operationId, generation: 2, pluginIds: ["notes"] },
            };
          },
        },
      );
      await harness.reloader.ready;
      try {
        if (boundary === "snapshot") {
          harness.emitWrite(writeNotification);
          await flushReload(harness.reloader);
          expect(harness.onHotReload).not.toHaveBeenCalled();
          expect(harness.onConfigAccepted).toHaveBeenLastCalledWith(
            config,
            expect.anything(),
            config,
            { runtimeApplied: false },
          );
        }
        applying = true;
        const operation = harness.reloader.applyPluginLifecycleChange({
          config,
          ...(boundary === "snapshot"
            ? { write: { persistedHash: "same", persistedSourceConfig: config } }
            : {}),
          pluginIds: ["notes"],
          reason: boundary === "snapshot" ? "disable" : "reload",
        });
        if (scenario === "same-source") {
          await expect(operation).resolves.toMatchObject({ generation: 2 });
          expect(operationIds).toHaveLength(1);
          await flushReload(harness.reloader);
          expect(harness.onHotReload).toHaveBeenCalledOnce();
        } else {
          await expect(operation).rejects.toBeInstanceOf(PluginRuntimeApplicationError);
          expect(operationIds).toHaveLength(boundary === "snapshot" ? 0 : 1);
        }
        expect(harness.onRestart).not.toHaveBeenCalled();
      } finally {
        await harness.reloader.stop();
      }
      if (scenario === "pending-write") {
        await expect(newerApplication.result).resolves.toBe("stopped");
      }
    },
  );

  it.each([false, true])(
    "owns writes during initial candidate preparation (stopped: %s)",
    async (stopped) => {
      const gate = createDeferred();
      const write = makeZeroDebounceHookWrite("during-initialization");
      let initial = true;
      const harness = createReloaderHarness(async () => write.snapshot, {
        prepareConfigCandidate: async ({ runtimeConfig, sourceConfig }) => {
          if (initial) {
            initial = false;
            await gate.promise;
          }
          return { runtimeConfig, compareConfig: sourceConfig };
        },
      });
      try {
        expect(harness.reloader.isReady()).toBe(false);
        expect(harness.reloader.hotReloadStatus()).toBeUndefined();
        let stopFinished = false;
        const stopping = stopped
          ? harness.reloader.stop().then(() => {
              stopFinished = true;
            })
          : undefined;
        await Promise.resolve();
        expect(stopFinished).toBe(false);
        harness.emitWrite(write);
        await vi.runAllTimersAsync();
        expect(harness.onHotReload).not.toHaveBeenCalled();
        expect(harness.watcher.adapter.start).not.toHaveBeenCalled();
        gate.resolve();
        if (stopping) {
          await expect(harness.reloader.ready).rejects.toThrow(GatewayConfigReloadSupersededError);
          await stopping;
          await vi.runAllTimersAsync();
          expect(harness.watcher.adapter.start).not.toHaveBeenCalled();
          expect(harness.onHotReload).not.toHaveBeenCalled();
          expect(configAuditMocks.upsertSnapshot).not.toHaveBeenCalled();
        } else {
          await harness.reloader.ready;
          await flushReload(harness.reloader);
          expect(getOnlyHotReloadCall(harness)[1]).toEqual(write.runtimeConfig);
          expect(harness.reloader.isReady()).toBe(true);
          expect(
            configAuditMocks.upsertSnapshot.mock.calls.map(([snapshot]) => snapshot.rawHash),
          ).not.toContain(hashConfigRaw(JSON.stringify({ gateway: { reload: {} } })));
        }
      } finally {
        gate.resolve();
        await harness.reloader.stop();
      }
    },
  );

  it.each(["unchanged", "missing", "new include", "read failure"] as const)(
    "reconciles the initial watch scan: %s",
    async (kind) => {
      const gate = createDeferred<ConfigFileSnapshot>();
      const observed = vi.fn();
      const unchanged = kind === "unchanged" || kind === "missing";
      const config = { gateway: { reload: {} } };
      const nextConfig = kind === "read failure" ? { ...config, hooks: { enabled: true } } : config;
      const snapshot = makeSnapshot({
        exists: kind !== "missing",
        config: nextConfig,
        ...(kind === "new include"
          ? { hash: "initial-raw-hash", includedPaths: ["/tmp/new.json5"] }
          : {}),
        ...(kind === "read failure" ? { hash: "new-disk-config" } : {}),
      });
      const readSnapshot = vi.fn(async () => snapshot).mockImplementationOnce(() => gate.promise);
      const harness = createReloaderHarness(readSnapshot, {
        initialSnapshotRawHash: unchanged
          ? kind === "missing"
            ? null
            : hashConfigRaw(snapshot.raw)
          : undefined,
        initialIncludedPaths: kind === "new include" ? ["/tmp/old.json5"] : undefined,
        prepareConfigCandidate: async ({ runtimeConfig, sourceConfig }) => ({
          runtimeConfig,
          compareConfig: sourceConfig,
        }),
        onConfigCandidateObserved: observed,
      });
      try {
        await harness.reloader.ready;
        harness.watcher.emit("ready");
        expect(observed).not.toHaveBeenCalled();
        if (kind === "read failure") {
          gate.reject(new Error("initial read failed"));
        } else {
          gate.resolve(snapshot);
        }
        await flushReload(harness.reloader);
        if (unchanged) {
          expect(observed).not.toHaveBeenCalled();
          expect(harness.onConfigAccepted).not.toHaveBeenCalled();
          expect(harness.onRestart).not.toHaveBeenCalled();
        } else if (kind === "new include") {
          expect(harness.watcher.paths).toEqual(["/tmp/openclaw.json", "/tmp/new.json5"]);
          expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
        } else {
          expect(getOnlyHotReloadCall(harness)[1]).toEqual(nextConfig);
          expect(harness.log.warn).toHaveBeenCalledWith(
            expect.stringContaining("initial read failed"),
          );
        }
      } finally {
        gate.resolve(makeSnapshot());
        await harness.reloader.stop();
      }
    },
  );

  it.each(["root", "include"] as const)(
    "reconciles %s changes made during startup admission",
    async (changedFile) => {
      const gate = createDeferred();
      let initial = true;
      const initialConfig = { gateway: { reload: {} } };
      const initialRoot =
        changedFile === "include"
          ? { ...initialConfig, hooks: { $include: "./hooks.json5" } }
          : initialConfig;
      let disk = makeSnapshot({
        config: initialConfig,
        parsed: initialRoot,
        hash: "initial-revision",
      });
      const includedPaths = changedFile === "include" ? ["/tmp/hooks.json5"] : [];
      const harness = createReloaderHarness(async () => disk, {
        initialSnapshotRawHash: hashConfigRaw(disk.raw),
        initialAuthoredConfig: initialRoot,
        initialIncludedPaths: includedPaths,
        prepareConfigCandidate: async ({ runtimeConfig, sourceConfig }) => {
          if (initial) {
            initial = false;
            await gate.promise;
          }
          return { runtimeConfig, compareConfig: sourceConfig };
        },
      });
      try {
        const nextConfig = { gateway: { reload: {} }, hooks: { enabled: true } };
        disk = makeSnapshot({
          config: nextConfig,
          parsed: changedFile === "include" ? initialRoot : nextConfig,
          hash: "written-during-preparation",
          includedPaths,
        });
        gate.resolve();
        await harness.reloader.ready;
        expect(harness.onHotReload).not.toHaveBeenCalled();
        harness.watcher.emit("ready");
        await flushReload(harness.reloader);
        expect(getOnlyHotReloadCall(harness)[1]).toEqual(nextConfig);
      } finally {
        gate.resolve();
        await harness.reloader.stop();
      }
    },
  );

  it.each(["write", "replace"] as const)(
    "discards an initial watch read superseded by %s",
    async (supersededBy) => {
      const gate = createDeferred<ConfigFileSnapshot>();
      const observed = vi.fn();
      const readSnapshot = vi
        .fn(async () => makeZeroDebounceHookSnapshot("newer-write"))
        .mockImplementationOnce(() => gate.promise);
      const harness = createReloaderHarness(readSnapshot, {
        prepareConfigCandidate: async ({ runtimeConfig, sourceConfig }) => ({
          runtimeConfig,
          compareConfig: sourceConfig,
        }),
        onConfigCandidateObserved: observed,
      });
      try {
        await harness.reloader.ready;
        harness.watcher.emit("ready");
        expect(observed).not.toHaveBeenCalled();
        if (supersededBy === "write") {
          const application = createRuntimeConfigWriteApplication();
          harness.emitWrite(
            attachRuntimeConfigWriteApplication(
              makeZeroDebounceHookWrite("newer-write"),
              application,
            ),
          );
          await vi.advanceTimersByTimeAsync(0);
          await application.result;
          expect(getOnlyHotReloadCall(harness)[1].hooks?.enabled).toBe(true);
        } else {
          harness.watcher.emit("error", new Error("watch failed"));
        }
        observed.mockClear();
        gate.resolve(makeSnapshot({ config: { hooks: { enabled: false } }, hash: "stale-read" }));
        await vi.advanceTimersByTimeAsync(0);
        expect(observed).not.toHaveBeenCalled();
        expect(harness.onRestart).not.toHaveBeenCalled();
      } finally {
        gate.resolve(makeSnapshot());
        await harness.reloader.stop();
      }
    },
  );

  it("does not duplicate another OpenClaw process's journaled write", async () => {
    const initialConfig = makeGatewayPortConfig(18789);
    const nextConfig = makeGatewayPortConfig(18790);
    const harness = createReloaderHarness(
      vi.fn(async () =>
        makeSnapshot({
          config: nextConfig,
          hash: "other-write",
        }),
      ),
      { initialConfig },
    );
    await harness.reloader.ready;
    configAuditMocks.readLatestSnapshot.mockReturnValue({
      configPath: "/tmp/openclaw.json",
      rawHash: hashConfigRaw(JSON.stringify(nextConfig)),
      fingerprintedAuthoredConfig: fingerprintConfigSnapshotAuthoredConfig(nextConfig),
    });
    configAuditMocks.append.mockClear();

    await flushWatcherChange(harness);

    expect(configAuditMocks.append).not.toHaveBeenCalled();
    expect(configAuditMocks.upsertSnapshot.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        configPath: "/tmp/openclaw.json",
        rawHash: hashConfigRaw(JSON.stringify(nextConfig)),
        authoredConfig: nextConfig,
      }),
    );
  });

  it("deduplicates invalid snapshots by observed raw hash", async () => {
    const firstInvalid = makeSnapshot({
      valid: false,
      parsed: { gateway: { port: "first-invalid" } },
      hash: "invalid-raw-hash-1",
      issues: [{ path: "gateway.port", message: "expected number" }],
    });
    const secondInvalid = makeSnapshot({
      valid: false,
      parsed: { gateway: { port: "second-invalid" } },
      hash: "invalid-raw-hash-2",
      issues: [{ path: "gateway.port", message: "expected number" }],
    });
    let activeSnapshot = firstInvalid;
    const harness = createReloaderHarness(vi.fn(async () => activeSnapshot));
    await harness.reloader.ready;
    configAuditMocks.append.mockClear();

    await flushWatcherChange(harness);
    await flushWatcherChange(harness);

    expect(configAuditMocks.append).toHaveBeenCalledOnce();
    activeSnapshot = secondInvalid;
    await flushWatcherChange(harness);

    expect(configAuditMocks.append).toHaveBeenCalledTimes(2);
    expect(configAuditMocks.append.mock.calls[1]?.[0]?.record).toMatchObject({
      detectedBy: "watch",
      previousHash: hashConfigRaw(firstInvalid.raw),
      nextHash: hashConfigRaw(secondInvalid.raw),
      valid: false,
    });
  });

  it.each([18790, 18789])(
    "journals a valid edit to port %s after an invalid edit",
    async (port) => {
      const initialConfig = makeGatewayPortConfig(18789);
      const invalid = makeSnapshot({
        valid: false,
        parsed: { gateway: { port: "invalid" } },
        hash: "invalid-raw-hash",
        issues: [{ path: "gateway.port", message: "expected number" }],
      });
      const nextConfig = makeGatewayPortConfig(port);
      let activeSnapshot = invalid;
      const harness = createReloaderHarness(
        vi.fn(async () => activeSnapshot),
        { initialConfig },
      );
      await harness.reloader.ready;
      configAuditMocks.append.mockClear();

      await flushWatcherChange(harness);
      activeSnapshot = makeSnapshot({
        config: nextConfig,
        hash: "valid-raw-hash",
      });
      await flushWatcherChange(harness);

      expect(configAuditMocks.append.mock.calls[1]?.[0]?.record).toMatchObject({
        detectedBy: "watch",
        previousHash: hashConfigRaw(invalid.raw),
        nextHash: hashConfigRaw(JSON.stringify(nextConfig)),
        valid: true,
        ...(port === 18789 ? { opaqueChange: true } : { changedPaths: ["gateway.port"] }),
      });
    },
  );

  it.each(["invalid", "missing"] as const)(
    "journals a rejected %s startup edit without clearing the snapshot slot",
    async (kind) => {
      configAuditMocks.readLatestSnapshot.mockReturnValue({
        configPath: "/tmp/openclaw.json",
        rawHash: "previous-raw-hash",
        fingerprintedAuthoredConfig: { gateway: { port: 18789 } },
      });
      const rawHash = kind === "missing" ? null : "invalid-raw-hash";
      const harness = createWriteReloaderHarness({
        initialSnapshotRawHash: rawHash,
        initialAuthoredConfig: kind === "missing" ? {} : { gateway: { port: "invalid" } },
        initialSnapshotValid: kind === "missing",
        initialSnapshotIssues: [{ path: "gateway.port", message: "expected number" }],
      });
      await harness.reloader.ready;

      expect(configAuditMocks.append).toHaveBeenCalledOnce();
      expect(configAuditMocks.append.mock.calls[0]?.[0]?.record).toMatchObject({
        event: "config.external",
        detectedBy: "startup",
        previousHash: "previous-raw-hash",
        nextHash: rawHash,
        valid: false,
        issues: [kind === "missing" ? "config file missing" : "gateway.port: expected number"],
      });
      expect(configAuditMocks.append.mock.calls[0]?.[0]?.record).not.toHaveProperty("changedPaths");
      expect(configAuditMocks.upsertSnapshot).not.toHaveBeenCalled();
    },
  );

  it("journals mixed secret and non-secret offline startup edits", async () => {
    const previousConfig: OpenClawConfig = {
      gateway: { auth: { mode: "token", token: "alpha" }, port: 18789 },
    };
    const initialConfig: OpenClawConfig = {
      gateway: { auth: { mode: "token", token: "beta" }, port: 18790 },
    };
    configAuditMocks.readLatestSnapshot.mockReturnValue({
      configPath: "/tmp/openclaw.json",
      rawHash: "previous-raw-hash",
      fingerprintedAuthoredConfig: fingerprintConfigSnapshotAuthoredConfig(previousConfig),
    });

    const harness = createWriteReloaderHarness({
      initialConfig,
      initialSnapshotRawHash: "current-raw-hash",
      initialAuthoredConfig: initialConfig,
    });
    await harness.reloader.ready;

    expect(configAuditMocks.append.mock.calls[0]?.[0]?.record).toMatchObject({
      event: "config.external",
      detectedBy: "startup",
      changedPaths: ["gateway.auth.token", "gateway.port"],
    });
    expect(configAuditMocks.append.mock.calls[0]?.[0]?.record).not.toHaveProperty("opaqueChange");
  });

  it("reseeds the slot without an external record when it belongs to another config path", async () => {
    const storedSnapshot = {
      configPath: "/tmp/config-a.json",
      rawHash: "path-a-raw-hash",
      fingerprintedAuthoredConfig: fingerprintConfigSnapshotAuthoredConfig({
        gateway: { port: 18789 },
      }),
    };
    // The unfiltered read still surfaces the foreign slot: it must become the
    // CAS token so path B can take the slot over, without seeding reconcile.
    configAuditMocks.readLatestSnapshot.mockReturnValue(storedSnapshot);
    const initialConfig: OpenClawConfig = { gateway: { port: 18790 } };
    const harness = createWriteReloaderHarness({
      initialConfig,
      initialSnapshotRawHash: "path-b-raw-hash",
      initialAuthoredConfig: initialConfig,
    });
    await harness.reloader.ready;

    expect(configAuditMocks.append).not.toHaveBeenCalled();
    expect(configAuditMocks.upsertSnapshot.mock.calls.map(([snapshot]) => snapshot)).toContainEqual(
      expect.objectContaining({
        configPath: "/tmp/openclaw.json",
        rawHash: "path-b-raw-hash",
        authoredConfig: initialConfig,
        expectedSnapshot: storedSnapshot,
      }),
    );
  });

  it.each(["direct", "watcher-echo", "failed-cleanup", "committed", "carried-successor"] as const)(
    "settles an RPC write inside its originating gateway root (%s)",
    async (scenario) => {
      const root = tempDirs.make("openclaw-config-receipt-");
      const bundledPluginsDir = tempDirs.make("openclaw-config-receipt-bundled-");
      const configPath = nodePath.join(root, "openclaw.json");
      // Reloads discover plugins per operation; this admission fixture declares none.
      const configEnv = {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      };
      const initialConfig = {
        gateway: { reload: {} },
        hooks: { enabled: false },
      } satisfies OpenClawConfig;
      const nextConfig = {
        gateway: { reload: {} },
        hooks: { enabled: true },
      } satisfies OpenClawConfig;
      await writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`);
      resetConfigRuntimeState();
      setRuntimeConfigSnapshot(initialConfig, initialConfig);
      initializePublishedConfigRuntimeEnv(initialConfig);

      const watcher = installWatcherMock();
      const hotReloadGate = createDeferred();
      const hotReloadStarted = createDeferred();
      const competingRootCounts: number[] = [];
      const onHotReload = vi.fn(
        async (
          plan: GatewayReloadPlan,
          runtimeConfig: OpenClawConfig,
          ownership: GatewayConfigReloadTransactionOwnership,
        ) => {
          competingRootCounts.push(getActiveGatewayRootWorkCount({ excludeCurrent: true }));
          hotReloadStarted.resolve();
          await hotReloadGate.promise;
          if (
            scenario !== "direct" &&
            scenario !== "carried-successor" &&
            competingRootCounts.length === 1
          ) {
            if (scenario === "committed") {
              ownership.markRuntimeCommitted(runtimeConfig, plan);
            }
            watcher.emit("change", configPath);
            const superseded = new GatewayConfigReloadSupersededError();
            throw new PluginRuntimeApplicationError(
              "Plugin replacement superseded",
              {
                operationId: "config-write",
                generation: 1,
                pluginIds: ["notes"],
                phase: scenario === "committed" ? "activate" : "drain",
                committed: scenario === "committed",
              },
              {
                cause:
                  scenario === "failed-cleanup"
                    ? new AggregateError([superseded, new Error("cleanup failed")])
                    : superseded,
              },
            );
          }
          ownership.markRuntimeCommitted(runtimeConfig, plan);
          return "applied" as const;
        },
      );
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      try {
        await withEnvAsync(configEnv, async () => {
          const configIo = createConfigIO({ configPath, pluginValidation: "skip" });
          const reloader = startGatewayConfigReloader({
            testDebounceMs: 0,
            initialConfig,
            initialSnapshotRawHash: (await configIo.readConfigFileSnapshot()).hash ?? null,
            initialAuthoredConfig: initialConfig,
            initialSnapshotValid: true,
            initialSnapshotIssues: [],
            readSnapshot: readConfigFileSnapshotForRuntimeTransaction,
            promoteSnapshot: async () => true,
            initialPluginInstallRecords: {},
            readPluginInstallRecords: async () => ({}),
            subscribeToWrites: (listener) =>
              registerConfigWriteListener(listener, {
                ownsRuntimeActivationFor: configPath,
                preCommitRuntimePreflight: async (sourceConfig) => ({
                  runtimeConfig: sourceConfig,
                  compareConfig: sourceConfig,
                }),
              }),
            onConfigChange: async () => {},
            onConfigApplied: async () => {},
            onConfigRevisionApplied: () => {},
            onConfigAccepted: async () => {},
            onEffectiveConfigUnchanged: async () => ({ rollback: async () => {} }),
            onNoopConfigCommit: async (plan, runtimeConfig, ownership) => {
              ownership.markRuntimeCommitted(runtimeConfig, plan);
            },
            onHotReload,
            onRestart: async () => {
              throw new Error("unexpected restart");
            },
            runTransaction: runWithGatewayIndependentRootWorkAdmission,
            log,
            watchPath: configPath,
          });
          await reloader.ready;

          try {
            const request = tryBeginGatewayRootWorkAdmission();
            if (!request) {
              throw new Error("expected gateway request admission");
            }
            const writeResult = await request.run(async () => {
              const prepared = await readConfigFileSnapshotForWrite();
              return await commitGatewayConfigWrite({
                snapshot: prepared.snapshot,
                writeOptions: prepared.writeOptions,
                nextConfig,
                awaitRuntimeApplication: true,
              });
            });
            let successorRequest: ReturnType<typeof tryBeginGatewayRootWorkAdmission> = null;
            let successorWrite: typeof writeResult | undefined;
            try {
              let settled = false;
              void writeResult.application?.then(() => {
                settled = true;
                request.release();
              });

              await vi.advanceTimersByTimeAsync(0);
              await hotReloadStarted.promise;
              expect(onHotReload).toHaveBeenCalledOnce();
              expect(settled).toBe(false);

              if (scenario === "carried-successor") {
                successorRequest = tryBeginGatewayRootWorkAdmission();
                if (!successorRequest) {
                  throw new Error("expected successor writer admission");
                }
                successorWrite = await successorRequest.run(async () => {
                  const prepared = await readConfigFileSnapshotForWrite();
                  return await commitGatewayConfigWrite({
                    snapshot: prepared.snapshot,
                    writeOptions: prepared.writeOptions,
                    nextConfig: { ...prepared.snapshot.sourceConfig, logging: { level: "debug" } },
                    awaitRuntimeApplication: true,
                  });
                });
                void successorWrite.application?.then(successorRequest.release);
                expect(settled).toBe(false);
              }

              hotReloadGate.resolve();
              await vi.waitFor(() => expect(settled).toBe(true));
              await flushReload(reloader);
              const applied =
                scenario === "direct" ||
                scenario === "watcher-echo" ||
                scenario === "carried-successor";
              await expect(writeResult.application).resolves.toBe(applied ? "applied" : "failed");
              if (successorWrite) {
                await expect(successorWrite.application).resolves.toBe("applied");
              }
              // Timer advancement does not join the watcher's real filesystem reread.
              await vi.waitFor(() =>
                expect(competingRootCounts).toEqual(
                  scenario === "watcher-echo" || scenario === "failed-cleanup" ? [0, 0] : [0],
                ),
              );
              if (applied) {
                expect(log.error).not.toHaveBeenCalled();
              } else {
                expect(log.error).toHaveBeenCalledOnce();
              }
            } finally {
              hotReloadGate.resolve();
              request.release();
              successorRequest?.release();
            }
          } finally {
            await reloader.stop();
          }
        });
      } finally {
        resetConfigRuntimeState();
      }
    },
  );

  it("updates reload owners only for accepted off/on policy, including skipped runtime apply", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: { mode: "hybrid" } },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { mode: "off" } },
      ui: { prefs: { themeMode: "light" } },
    };
    let snapshot = makeSnapshot({ config: nextConfig, hash: "mode-off-write" });
    const readSnapshot = vi.fn(async () => snapshot);
    const harness = createReloaderHarness(readSnapshot, { initialConfig });
    await harness.reloader.ready;
    expect(harness.onReloadEnabledChange.mock.calls).toEqual([[true]]);

    await flushWatcherChange(harness);

    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.onRestart).not.toHaveBeenCalled();
    expect(harness.onConfigCandidateCommitted).toHaveBeenCalledOnce();
    expect(harness.onReloadEnabledChange.mock.calls).toEqual([[true], [false]]);

    snapshot = makeSnapshot({
      config: initialConfig,
      valid: false,
      raw: '{ "gateway": { "reload": { "mode": "hybrid" }, "port": "invalid" } }',
      hash: "invalid-reenable",
      issues: [{ path: "gateway.port", message: "Expected number" }],
    });
    await flushWatcherChange(harness);
    expect(harness.onReloadEnabledChange.mock.calls).toEqual([[true], [false]]);

    // The effective runtime never changed while off, so returning to its
    // original config must still re-enable independent reload owners.
    snapshot = makeSnapshot({ config: initialConfig, hash: "mode-on-write" });
    await flushWatcherChange(harness);
    expect(harness.onReloadEnabledChange.mock.calls).toEqual([[true], [false], [true]]);
    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.onRestart).not.toHaveBeenCalled();
  });

  it("revalidates changed effective config when an accepted write hash is unchanged", async () => {
    const initialConfig = {
      gateway: { reload: {}, port: 18_789 },
    } satisfies OpenClawConfig;
    const unavailableSecret = {
      source: "env" as const,
      provider: "default",
      id: "INCLUDED_GATEWAY_TOKEN",
    };
    const effectiveConfig = {
      gateway: {
        reload: {},
        port: 19_001,
        auth: { mode: "token" as const, token: unavailableSecret },
      },
    } satisfies OpenClawConfig;
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({
        config: effectiveConfig,
        hash: "unchanged-root-hash",
      }),
    );
    const onRestart = vi.fn(
      async (
        _plan: GatewayReloadPlan,
        _nextConfig: OpenClawConfig,
        _ownership: GatewayConfigReloadTransactionOwnership,
        _sourceConfig: OpenClawConfig,
      ) => {
        throw new Error("required SecretRef INCLUDED_GATEWAY_TOKEN is unavailable");
      },
    );
    const harness = createReloaderHarness(readSnapshot, {
      initialConfig,
      initialCompareConfig: initialConfig,
      onRestart,
    });
    await harness.reloader.ready;

    harness.emitWrite(makeWrite(initialConfig, "unchanged-root-hash"));
    await flushReload(harness.reloader);
    harness.onConfigAccepted.mockClear();

    await flushWatcherChange(harness);

    expect(onRestart).toHaveBeenCalledOnce();
    expect(onRestart.mock.calls[0]?.[3]).toEqual(effectiveConfig);
    expect(harness.onConfigAccepted).not.toHaveBeenCalled();
    expect(harness.log.error).toHaveBeenCalledWith(
      "config reload failed: Error: required SecretRef INCLUDED_GATEWAY_TOKEN is unavailable",
    );
  });

  it.each(["baseline-only", "invalid", "missing", "restart"] as const)(
    "applies the committed runtime owner before a superseding %s candidate",
    async (kind) => {
      const { clock, scheduler } = createConfigReloadTestClock();
      const initialConfig = {
        gateway: { reload: {}, terminal: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "off" as const } } },
      } satisfies OpenClawConfig;
      const appliedConfig = {
        ...initialConfig,
        agents: { defaults: { sandbox: { mode: "all" as const } } },
      } satisfies OpenClawConfig;
      const nextConfig = {
        ...initialConfig,
        gateway: { ...initialConfig.gateway, ...(kind === "restart" ? { port: 19_001 } : {}) },
      };
      const rejected = kind === "invalid" || kind === "missing";
      const rejectedSnapshot = makeSnapshot({
        valid: false,
        exists: kind !== "missing",
        hash: `${kind}-b`,
      });
      let persistedSnapshot = makeSnapshot({ config: initialConfig });
      const terminalPolicy = createTerminalLaunchPolicy(initialConfig);
      const events: string[] = [];
      const harness = createReloaderHarness(
        vi.fn(async () => (rejected ? rejectedSnapshot : persistedSnapshot)),
        {
          scheduler,
          initialConfig,
          initialCompareConfig: initialConfig,
          onHotReload: async (plan, config, ownership) => {
            terminalPolicy.prepareConfig(config, { restartPending: false });
            ownership.markRuntimeCommitted(config, plan);
            if (rejected) {
              harness.watcher.emit("change");
            } else {
              emitWrite(
                nextConfig,
                `${kind}-b`,
                2,
                kind === "baseline-only"
                  ? { mode: "none", reason: "baseline-only acceptance" }
                  : undefined,
              );
            }
            return "applied";
          },
          onConfigApplied: () => {
            events.push("applied");
            terminalPolicy.commitConfig();
          },
          onConfigRevisionApplied: () => {
            if (kind === "baseline-only") {
              events.push("revision-applied");
            }
          },
          onConfigChange: (plan, config) => {
            if (kind === "restart") {
              events.push("prepared");
              terminalPolicy.prepareConfig(config, { restartPending: plan.restartGateway });
            }
          },
          onConfigAccepted: () => {
            if (!rejected) {
              events.push("accepted");
              terminalPolicy.acceptConfig({ retireRejectedRestart: false });
            }
          },
        },
      );
      const emitWrite = (
        config: OpenClawConfig,
        hash: string,
        revision: number,
        afterWrite?: ConfigWriteNotification["afterWrite"],
      ) => {
        persistedSnapshot = makeSnapshot({ config, hash });
        harness.emitWrite(
          makeWrite(config, hash, { snapshot: persistedSnapshot, revision, afterWrite }),
        );
      };
      await harness.reloader.ready;
      emitWrite(appliedConfig, "runtime-a", 1);
      // The committed owner settles in the next pass after its superseding observation.
      await clock.advanceBy(0);
      await clock.advanceBy(0);
      if (rejected) {
        expect(harness.onConfigApplied).toHaveBeenCalledOnce();
      } else {
        expect(events).toEqual(
          kind === "baseline-only"
            ? ["applied", "revision-applied", "accepted", "accepted"]
            : ["prepared", "applied", "accepted", "prepared", "accepted"],
        );
      }
      expect(terminalPolicy.resolve()).toMatchObject({
        ok: false,
        block: { kind: "sandboxed", mode: "all" },
      });
    },
  );

  it("plans the reverse hot reload when config A commits before config B supersedes its tail", async () => {
    const initialConfig = {
      gateway: { reload: {} },
      hooks: { enabled: true, token: "test-token", path: "/old" },
    } satisfies OpenClawConfig;
    const configA = {
      ...initialConfig,
      hooks: { ...initialConfig.hooks, path: "/a" },
    } satisfies OpenClawConfig;
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(makeSnapshot({ config: configA, hash: "post-commit-a" }))
      .mockResolvedValue(makeSnapshot({ config: initialConfig, hash: "reverse-b" }));
    const { promise: committed, resolve: recordCommitted } = createDeferred();
    const { promise: tailGate, resolve: releaseTail } = createDeferred();
    const onHotReload = vi.fn(
      async (
        plan: GatewayReloadPlan,
        nextConfig: OpenClawConfig,
        ownership: GatewayConfigReloadTransactionOwnership,
      ) => {
        ownership.markRuntimeCommitted(nextConfig, plan);
        if (nextConfig === configA) {
          recordCommitted?.();
          await tailGate;
        }
        return "applied" as const;
      },
    );
    const promoteSnapshot = vi.fn(async (_snapshot: ConfigFileSnapshot, _reason: string) => true);
    const harness = createReloaderHarness(readSnapshot, {
      initialConfig,
      onHotReload,
      promoteSnapshot,
    });
    await harness.reloader.ready;

    harness.watcher.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    await committed;

    harness.watcher.emit("change");
    releaseTail();
    await flushReload(harness.reloader);

    expect(onHotReload).toHaveBeenCalledTimes(2);
    expect(onHotReload.mock.calls.map(([, config]) => config)).toEqual([configA, initialConfig]);
    expect(onHotReload.mock.calls[1]?.[0].hotReasons).toContain("hooks.path");
    expect(harness.onConfigAccepted).toHaveBeenCalledTimes(2);
    expect(harness.onConfigAccepted.mock.calls.map((call) => call[0])).toEqual([
      configA,
      initialConfig,
    ]);
    expect(harness.onConfigApplied).toHaveBeenCalledTimes(2);
    expect(harness.onConfigApplied.mock.calls.map(([, config]) => config)).toEqual([
      configA,
      initialConfig,
    ]);
    expect(promoteSnapshot.mock.calls.map(([snapshot]) => snapshot.hash)).toEqual([
      "post-commit-a",
      "reverse-b",
    ]);
  });

  it("prepares a superseding config against the env owner committed at the runtime edge", async () => {
    const envKey = "OPENCLAW_TEST_COMMITTED_ENV_SOURCE";
    const targetEnv: NodeJS.ProcessEnv = { [envKey]: "old" };
    const initialConfig = {
      gateway: { reload: {} },
      hooks: { enabled: true, token: "test-token", path: "/old" },
      env: { vars: { [envKey]: "old" } },
    } satisfies OpenClawConfig;
    const configA = {
      ...initialConfig,
      hooks: { ...initialConfig.hooks, path: "/a" },
      env: { vars: { [envKey]: "a" } },
    } satisfies OpenClawConfig;
    const configB = {
      ...initialConfig,
      hooks: { ...initialConfig.hooks, path: "/b" },
      env: { vars: { [envKey]: "b" } },
    } satisfies OpenClawConfig;
    const preparedEnvValues: Array<string | undefined> = [];
    const harness = createWriteReloaderHarness({
      initialConfig,
      prepareConfigCandidate: async ({ runtimeConfig, sourceConfig, previousSourceConfig }) => ({
        runtimeConfig,
        compareConfig: { ...sourceConfig, env: initialConfig.env },
        runtimeEnv: prepareConfigRuntimeEnv({
          previousConfig: previousSourceConfig,
          nextConfig: sourceConfig,
          env: targetEnv,
          previousOwnedEnv: {
            [envKey]: previousSourceConfig.env?.vars?.[envKey] ?? "",
          },
        }),
      }),
      onHotReload: async (plan, nextConfig, ownership) => {
        preparedEnvValues.push(ownership.runtimeEnv?.env[envKey]);
        ownership.publishRuntimeEnv();
        ownership.markRuntimeCommitted(nextConfig, plan);
        if (nextConfig === configA) {
          emitWrite(configB, "env-b", 2);
        }
        return "applied";
      },
    });
    await harness.reloader.ready;
    const emitWrite = (config: OpenClawConfig, hash: string, revision: number) => {
      harness.emitWrite(
        makeWrite(config, hash, {
          snapshot: makeSnapshot({ config, hash }),
          revision,
        }),
      );
    };

    emitWrite(configA, "env-a", 1);
    await flushReload(harness.reloader);

    expect(preparedEnvValues).toEqual(["a", "b"]);
    expect(targetEnv[envKey]).toBe("b");
  });

  it.each(["noop", "hot"] as const)(
    "publishes %s config changes between lifecycle preparation and completion",
    async (kind) => {
      const initialConfig: OpenClawConfig = {
        gateway: { reload: {} },
        ...(kind === "noop"
          ? { messages: { visibleReplies: "automatic" } }
          : { agents: { defaults: { sandbox: { mode: "off" } } }, hooks: { enabled: false } }),
      };
      const nextConfig: OpenClawConfig = {
        gateway: { reload: {} },
        ...(kind === "noop"
          ? { messages: { visibleReplies: "message_tool" } }
          : { agents: { defaults: { sandbox: { mode: "all" } } }, hooks: { enabled: true } }),
      };
      const harness = createReloaderHarness(
        async () => makeSnapshot({ config: nextConfig, hash: kind }),
        { initialConfig },
      );
      await harness.reloader.ready;
      await flushWatcherChange(harness);

      const apply = kind === "noop" ? harness.onNoopConfigCommit : harness.onHotReload;
      expect(apply).toHaveBeenCalledOnce();
      expect(apply.mock.calls[0]?.[1]).toBe(nextConfig);
      expect(harness.onRestart).not.toHaveBeenCalled();
      if (kind === "noop") {
        expect(apply.mock.calls[0]?.[0].noopPaths).toContain("messages.visibleReplies");
        expect(harness.onHotReload).not.toHaveBeenCalled();
      }
      expect(harness.onConfigChange.mock.invocationCallOrder[0]).toBeLessThan(
        apply.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(apply.mock.invocationCallOrder[0]).toBeLessThan(
        harness.onConfigApplied.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(harness.onConfigRevisionApplied).toHaveBeenCalledWith(
        hashRuntimeConfigValue(nextConfig),
      );
    },
  );

  it("caps missing-file retries and skips reload after retry budget is exhausted", async () => {
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValue(makeSnapshot({ exists: false, raw: null, hash: "missing" }));
    const { watcher, onHotReload, onRestart, log, reloader } = createReloaderHarness(readSnapshot);
    await reloader.ready;

    watcher.emit("unlink");
    await flushReload(reloader);
    await flushReload(reloader, 150);
    await flushReload(reloader, 150);

    expect(readSnapshot).toHaveBeenCalledTimes(3);
    expect(onHotReload).not.toHaveBeenCalled();
    expect(onRestart).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("config reload skipped (config file not found)");

    await reloader.stop();
  });

  it("contains superseded restarts and retries the same config", async () => {
    const snapshot = makeSnapshot({
      config: {
        gateway: { reload: {}, port: 18790 },
      },
      hash: "restart-1",
    });
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(snapshot);
    const promoteSnapshot = vi.fn(async () => true);
    const { watcher, onHotReload, onRestart, log, reloader } = createReloaderHarness(readSnapshot, {
      promoteSnapshot,
    });
    await reloader.ready;
    onRestart.mockRejectedValueOnce(new GatewayConfigReloadSupersededError());
    onRestart.mockResolvedValueOnce(undefined);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      watcher.emit("change");
      await flushReload(reloader);
      await Promise.resolve();

      expect(onHotReload).not.toHaveBeenCalled();
      expect(onRestart).toHaveBeenCalledTimes(1);
      expect(log.info).toHaveBeenCalledWith(
        "config restart superseded: GatewayConfigReloadSupersededError: config reload superseded by a newer runtime config source",
      );
      expect(log.info).toHaveBeenCalledWith(
        "config reload superseded: GatewayConfigReloadSupersededError: config reload superseded by a newer runtime config source",
      );
      expect(log.error).not.toHaveBeenCalled();
      expect(promoteSnapshot).not.toHaveBeenCalled();
      expect(unhandled).toStrictEqual([]);

      watcher.emit("change");
      await flushReload(reloader);
      await Promise.resolve();

      expect(onRestart).toHaveBeenCalledTimes(2);
      expect(promoteSnapshot).toHaveBeenCalledWith(snapshot, "valid-config");
      expect(unhandled).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await reloader.stop();
    }
  });

  it("keeps accepted external config reloads applied when last-known-good promotion fails", async () => {
    const acceptedSnapshot = makeSnapshot({
      config: {
        gateway: { reload: {} },
        hooks: { enabled: true },
      },
      hash: "external-promotion-fails-1",
    });
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(acceptedSnapshot);
    const promoteSnapshot = vi.fn(async () => {
      throw new Error("disk full");
    });
    const { watcher, onHotReload, log, reloader } = createReloaderHarness(readSnapshot, {
      promoteSnapshot,
    });
    await reloader.ready;

    watcher.emit("change");
    await flushReload(reloader);

    expect(onHotReload).toHaveBeenCalledTimes(1);
    expect(promoteSnapshot).toHaveBeenCalledWith(acceptedSnapshot, "valid-config");
    expect(log.warn).toHaveBeenCalledWith(
      "config reload last-known-good promotion failed: Error: disk full",
    );

    await reloader.stop();
  });

  it.each([
    ...(
      [
        "pending",
        "active",
        "active-superseded",
        "retry-active",
        "plugin-retry-active",
        "external",
      ] as const
    ).flatMap((boundary) =>
      (["applied", "overwritten", "failed"] as const).map((outcome) => ({ boundary, outcome })),
    ),
    { boundary: "external", outcome: "invalid" } as const,
    { boundary: "plugin", outcome: "applied" } as const,
    { boundary: "plugin-external", outcome: "applied" } as const,
  ])(
    "settles a $boundary config write when its successor is $outcome",
    async ({ boundary, outcome }) => {
      const external = boundary === "external" || boundary === "plugin-external";
      const plugin = boundary === "plugin" || boundary === "plugin-external";
      const pluginRetry = boundary === "plugin-retry-active";
      const retryActive = boundary === "retry-active" || pluginRetry;
      const completedFirst = boundary === "active" || boundary === "external" || retryActive;
      const initial: OpenClawConfig = { agents: { entries: { main: {}, removed: {} } } };
      const first: OpenClawConfig = { agents: { entries: { main: {}, alpha: {} } } };
      const next: OpenClawConfig = {
        agents: {
          entries:
            outcome === "overwritten"
              ? { main: {}, removed: {}, beta: {} }
              : { main: {}, alpha: {}, beta: {} },
        },
      };
      const firstEntered = createDeferred();
      const releaseFirst = createDeferred();
      const nextEntered = createDeferred();
      const releaseNext = createDeferred();
      const drainCounts: number[] = [];
      const drainHolders: string[][] = [];
      const { clock, scheduler } = createConfigReloadTestClock();
      let persisted = makeSnapshot({ config: initial, hash: "initial" });
      let needsFirstRetry = retryActive;
      const harness = createReloaderHarness(async () => persisted, {
        scheduler,
        initialConfig: initial,
        onHotReload: async (plan, config) => {
          if (!config.agents?.entries?.beta) {
            if (needsFirstRetry) {
              needsFirstRetry = false;
              throw new GatewayConfigReloadSupersededError();
            }
            firstEntered.resolve();
            await releaseFirst.promise;
            if (boundary === "active-superseded") {
              throw new GatewayConfigReloadSupersededError();
            }
          } else {
            drainCounts.push(getActiveGatewayRootWorkCount({ excludeCurrent: true }));
            drainHolders.push(getActiveGatewayRootWorkHolders({ excludeCurrent: true }));
            nextEntered.resolve();
            await releaseNext.promise;
            if (outcome === "failed") {
              throw new Error("successor runtime rejected");
            }
          }
          if (plan.pluginLifecycle) {
            return {
              status: "applied",
              runtime: { operationId: "carried-reload", generation: 1, pluginIds: ["notes"] },
            };
          }
          return "applied";
        },
      });
      const unsubscribe = registerRuntimeConfigWriteListener((event) => harness.emitWrite(event));
      const unrelated = tryBeginGatewayRootWorkAdmission("unrelated-turn");
      let pluginRequest: ReturnType<typeof tryBeginGatewayRootWorkAdmission> = null;
      let reloadCompletion: Promise<unknown> | undefined;
      const publish = async (previous: OpenClawConfig, config: OpenClawConfig, hash: string) => {
        const root = tryBeginGatewayRootWorkAdmission(`config:${hash}`);
        if (!root) {
          throw new Error("expected writer root admission");
        }
        return await root.run(async () => {
          const application = createRuntimeConfigWriteApplication(
            captureGatewayRootWorkAdmissionContinuationScope()?.run,
          );
          const sourceConfig: OpenClawConfig = {
            ...config,
            meta: {
              lastTouchedVersion: hash === "first" ? "2026.10.1" : "2026.10.2",
            },
          };
          persisted = makeSnapshot({ config, sourceConfig, hash });
          publishRuntimeConfigWrite({
            configPath: "/tmp/openclaw.json",
            snapshot: persisted,
            previousSourceConfig: previous,
            writtenSourceConfig: config,
            sourceConfig,
            runtimeConfig: config,
            persistedHash: hash,
            deferRuntimeActivation: true,
            preparedCandidates: new Map(),
            writeOptions: attachRuntimeConfigWriteApplication({}, application),
          });
          void application.result.finally(root.release);
          return application;
        });
      };
      try {
        await harness.reloader.ready;
        const older = await publish(initial, first, "first");
        const olderSettled = vi.fn();
        void older.result.then(olderSettled);
        if (retryActive) {
          await clock.wake();
          expect(olderSettled).not.toHaveBeenCalled();
          harness.watcher.emit("change");
        }
        const firstRun = pluginRetry
          ? harness.reloader.applyPluginLifecycleChange({
              config: persisted.sourceConfig,
              pluginIds: ["notes"],
              reason: "reload",
            })
          : completedFirst || boundary === "active-superseded"
            ? clock.wake()
            : undefined;
        if (firstRun) {
          await awaitGateBeforeSettlement(
            firstEntered.promise,
            firstRun,
            "reload did not enter first runtime application",
          );
        }
        const newer = external ? undefined : await publish(first, next, "next");
        if (external) {
          persisted = makeSnapshot({
            config: next,
            hash: "external",
            valid: outcome !== "invalid",
          });
          harness.watcher.emit("change");
        }
        releaseFirst.resolve();
        await firstRun;
        if (completedFirst) {
          expect(olderSettled).toHaveBeenCalledExactlyOnceWith("applied");
        }
        pluginRequest = plugin ? tryBeginGatewayRootWorkAdmission("plugin-request") : null;
        const nextRun = pluginRequest
          ? pluginRequest.run(() =>
              harness.reloader.applyPluginLifecycleChange({
                config: persisted.sourceConfig,
                pluginIds: ["notes"],
                reason: "reload",
                assertInvokerOwned: () => {
                  expect(getActiveGatewayRootWorkHolders({ excludeCurrent: true })).not.toContain(
                    "plugin-request",
                  );
                },
              }),
            )
          : clock.wake();
        reloadCompletion = Promise.resolve(nextRun).catch(() => {});
        if (outcome !== "invalid") {
          await awaitGateBeforeSettlement(
            nextEntered.promise,
            Promise.resolve(nextRun),
            "reload did not enter runtime application",
          );
          if (!completedFirst && outcome !== "overwritten") {
            expect(olderSettled).not.toHaveBeenCalled();
          }
        }
        releaseNext.resolve();
        await nextRun;
        pluginRequest?.release();
        await expect(older.result).resolves.toBe(
          completedFirst ? "applied" : outcome === "overwritten" ? "superseded" : outcome,
        );
        if (newer) {
          await expect(newer.result).resolves.toBe(outcome === "failed" ? "failed" : "applied");
        }
        expect(harness.onRestart).not.toHaveBeenCalled();
        expect(drainCounts).toEqual(outcome === "invalid" ? [] : [1]);
        expect(drainHolders).toEqual(outcome === "invalid" ? [] : [["unrelated-turn"]]);
        expect(getActiveGatewayRootWorkCount()).toBe(1);
      } finally {
        releaseFirst.resolve();
        releaseNext.resolve();
        unsubscribe();
        await reloadCompletion;
        await harness.reloader.stop();
        pluginRequest?.release();
        unrelated?.release();
      }
    },
  );

  it("applies a committed snapshot without disk reads and does not reapply its watcher echo", async () => {
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>(async () => {
      throw new Error("disk reads unavailable during this commit");
    });
    const write = makeZeroDebounceHookWrite("internal-1");
    const parsed = { gateway: { reload: {} }, hooks: { $include: "./hooks.json5" } };
    write.snapshot = {
      ...write.snapshot,
      raw: JSON.stringify(parsed),
      parsed,
      authoredConfig: write.sourceConfig,
      includedPaths: ["/tmp/hooks.json5"],
      includeProvenance: [
        {
          path: ["hooks"],
          kind: "single",
          targetPath: "/tmp/hooks.json5",
          hasSiblingOverrides: false,
        },
      ],
    };
    const promoteSnapshot = vi.fn(async (_snapshot: ConfigFileSnapshot, _reason: string) => true);
    const harness = createReloaderHarness(readSnapshot, { promoteSnapshot });
    await harness.reloader.ready;

    harness.emitWrite(write);
    await flushReload(harness.reloader);

    expect(readSnapshot).not.toHaveBeenCalled();
    expect(harness.onHotReload).toHaveBeenCalledTimes(1);
    const [promotedSnapshot, promotionReason] = getOnlyPromoteSnapshotCall(promoteSnapshot);
    expect(promotedSnapshot).toBe(write.snapshot);
    expect(promotionReason).toBe("in-process-write");

    readSnapshot.mockResolvedValue(write.snapshot);
    harness.watcher.emit("change");
    harness.watcher.emit("change");
    await flushReload(harness.reloader);

    expect(readSnapshot).toHaveBeenCalledOnce();
    expect(harness.onHotReload).toHaveBeenCalledTimes(1);

    readSnapshot.mockResolvedValue(
      makeSnapshot({ config: makeGatewayPortConfig(19001), hash: "external-1" }),
    );
    harness.watcher.emit("change");
    await flushReload(harness.reloader);

    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(harness.onHotReload).toHaveBeenCalledTimes(1);
    expect(harness.onRestart).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "rejected before runtime commit", markCommitted: false, expected: "old" },
    { label: "failed after runtime commit", markCommitted: true, expected: "candidate" },
  ] as const)("$label handles published config env ownership", async (testCase) => {
    const envKey = "OPENCLAW_TEST_RELOAD_ENV_COMMIT_EDGE";
    const targetEnv: NodeJS.ProcessEnv = { [envKey]: "old" };
    const initialConfig = {
      gateway: { reload: {} },
      hooks: { enabled: true, token: "test", path: "/old" },
      env: { vars: { [envKey]: "old" } },
    } satisfies OpenClawConfig;
    const nextConfig = {
      ...initialConfig,
      hooks: { ...initialConfig.hooks, path: "/next" },
      env: { vars: { [envKey]: "candidate" } },
    } satisfies OpenClawConfig;
    const compareConfig = {
      ...nextConfig,
      env: initialConfig.env,
    } satisfies OpenClawConfig;
    const runtimeEnv = prepareConfigRuntimeEnv({
      previousConfig: initialConfig,
      nextConfig,
      env: targetEnv,
      previousOwnedEnv: { [envKey]: "old" },
    });
    const harness = createWriteReloaderHarness({
      initialConfig,
      onHotReload: async (plan, runtimeConfig, ownership) => {
        ownership.publishRuntimeEnv();
        expect(targetEnv[envKey]).toBe("candidate");
        if (testCase.markCommitted) {
          ownership.markRuntimeCommitted(runtimeConfig, plan);
        }
        throw new Error("hot reload failed");
      },
    });
    await harness.reloader.ready;

    harness.emitWrite(
      makeWrite(nextConfig, `env-${testCase.label}`, {
        preparedCandidate: { runtimeConfig: nextConfig, compareConfig, runtimeEnv },
      }),
    );
    await flushReload(harness.reloader);

    expect(targetEnv[envKey]).toBe(testCase.expected);
  });

  it("reprepares a stale managed-write env candidate after another transaction accepts", async () => {
    const envKey = "OPENCLAW_TEST_INTERLEAVED_RELOAD_ENV";
    const targetEnv: NodeJS.ProcessEnv = { [envKey]: "a" };
    const makeConfig = (value: string, port: number): OpenClawConfig => ({
      gateway: { reload: {}, port },
      env: { vars: { [envKey]: value } },
    });
    const configA = makeConfig("a", 18_789);
    const configB = makeConfig("b", 19_001);
    const configC = makeConfig("c", 19_002);
    const staleRuntimeEnv = prepareConfigRuntimeEnv({
      previousConfig: configA,
      nextConfig: configB,
      env: targetEnv,
      previousOwnedEnv: { [envKey]: "a" },
    });
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({
        config: configC,
        hash: "env-c",
      }),
    );
    const harness = createReloaderHarness(readSnapshot, {
      initialConfig: configA,
      prepareConfigCandidate: async ({ runtimeConfig, sourceConfig, previousSourceConfig }) => ({
        runtimeConfig,
        compareConfig: sourceConfig,
        runtimeEnv: prepareConfigRuntimeEnv({
          previousConfig: previousSourceConfig,
          nextConfig: sourceConfig,
          env: targetEnv,
          previousOwnedEnv: {
            [envKey]: previousSourceConfig.env?.vars?.[envKey] ?? "",
          },
        }),
      }),
    });
    await harness.reloader.ready;

    await flushWatcherChange(harness);
    expect(targetEnv[envKey]).toBe("c");

    readSnapshot.mockResolvedValue(
      makeSnapshot({
        config: configB,
        hash: "env-b",
      }),
    );
    harness.emitWrite(
      makeWrite(configB, "env-b", {
        preparedCandidate: {
          runtimeConfig: configB,
          compareConfig: configB,
          runtimeEnv: staleRuntimeEnv,
        },
        revision: 2,
      }),
    );
    await flushReload(harness.reloader);

    expect(targetEnv[envKey]).toBe("b");
  });

  it.each(["before publication", "acceptance failure"])(
    "settles masked source publication after %s",
    async (failure) => {
      const { clock, scheduler } = createConfigReloadTestClock();
      const initialConfig = {
        gateway: { reload: {} },
        logging: { level: "info" as const },
      } satisfies OpenClawConfig;
      const sourceConfig = {
        ...initialConfig,
        logging: { level: "debug" as const },
      } satisfies OpenClawConfig;
      const publicationEvents: string[] = [];
      let publicationId = 0;
      const rollbackSource = vi.fn(async () => {});
      let rejectAcceptance = failure === "acceptance failure";
      let emitSupersedingChange = () => {};
      const harness = createReloaderHarness(
        vi.fn(async () => makeSnapshot({ config: initialConfig, hash: "superseding-write" })),
        {
          scheduler,
          initialConfig,
          onConfigAccepted: async (_nextConfig, _ownership, _sourceConfig, acceptance) => {
            if (failure === "before publication") {
              throw new Error("restart debt admission failed");
            }
            await acceptance.publishSource?.();
            queueMicrotask(emitSupersedingChange);
            if (rejectAcceptance) {
              rejectAcceptance = false;
              throw new Error(failure);
            }
          },
          onEffectiveConfigUnchanged: async () => {
            const id = publicationId++;
            return {
              rollback: async () => {
                publicationEvents.push(`rollback:${id}`);
                await rollbackSource();
              },
              commit: () => {
                publicationEvents.push(`commit:${id}`);
              },
            };
          },
        },
      );
      await harness.reloader.ready;
      emitSupersedingChange = () => {
        emitSupersedingChange = () => {};
        harness.watcher.emit("change");
      };

      harness.emitWrite(
        makeWrite(sourceConfig, "masked-source-superseded", {
          preparedCandidate: {
            runtimeConfig: initialConfig,
            compareConfig: initialConfig,
            reapplyRuntimeOverlays: () => initialConfig,
          },
        }),
      );
      // Join the rolled-back publication, then the replacement it queued.
      await clock.advanceBy(0);
      await clock.advanceBy(0);

      if (failure === "before publication") {
        expect(harness.onEffectiveConfigUnchanged).not.toHaveBeenCalled();
        expect(harness.log.error).toHaveBeenCalledWith(
          "config reload failed: Error: restart debt admission failed",
        );
      } else {
        expect(harness.onEffectiveConfigUnchanged).toHaveBeenCalledTimes(2);
        expect(harness.onEffectiveConfigUnchanged.mock.calls.map((call) => call[2])).toEqual([
          sourceConfig,
          initialConfig,
        ]);
        expect(rollbackSource).toHaveBeenCalledOnce();
        expect(publicationEvents).toEqual(["rollback:0", "commit:1"]);
        expect(harness.log.error).toHaveBeenCalledWith(`config reload failed: Error: ${failure}`);
      }

      await harness.reloader.stop();
    },
  );

  it.each([true, false])(
    "rebinds accepted overlays when a watcher echoes the same hash (runtime applied: %s)",
    async (runtimeApplied) => {
      const sourceConfig = makeZeroDebounceHookWrite("source-only-echo").sourceConfig;
      const applyDebugOverride = (config: OpenClawConfig): OpenClawConfig => ({
        ...config,
        logging: { level: "debug" },
      });
      const readSnapshot = vi.fn(async () => makeZeroDebounceHookSnapshot("source-only-echo"));
      const harness = createReloaderHarness(readSnapshot);
      await harness.reloader.ready;

      harness.emitWrite({
        ...makeZeroDebounceHookWrite("source-only-echo"),
        afterWrite: runtimeApplied
          ? undefined
          : { mode: "none", reason: "source owner handles follow-up" },
        preparedCandidate: {
          runtimeConfig: applyDebugOverride(sourceConfig),
          compareConfig: sourceConfig,
          reapplyRuntimeOverlays: applyDebugOverride,
        },
      });
      await flushReload(harness.reloader);

      await flushWatcherChange(harness);

      expect(harness.onConfigAccepted).toHaveBeenCalledTimes(2);
      expect(harness.onConfigAccepted.mock.calls.map((call) => call[3])).toEqual([
        { runtimeApplied },
        { runtimeApplied },
      ]);
      const reboundOwnership = harness.onConfigAccepted.mock.calls[1]?.[1];
      expect(reboundOwnership?.isCurrent()).toBe(true);
      expect(reboundOwnership?.reapplyRuntimeOverlays(sourceConfig).logging?.level).toBe("debug");
      expect(harness.onConfigAccepted.mock.calls[1]?.[0]).toEqual(applyDebugOverride(sourceConfig));
    },
  );

  it("passes canonical SecretRef source config to watcher-replayed restart preflight", async () => {
    const secretRef = {
      source: "env" as const,
      provider: "default",
      id: "REPLAY_RESTART_TOKEN",
    };
    const sourceConfig = {
      gateway: {
        reload: {},
        auth: { mode: "token" as const, token: secretRef },
      },
    } satisfies OpenClawConfig;
    const runtimeConfig = {
      gateway: {
        reload: {},
        auth: { mode: "token" as const, token: "resolved-replay-token" },
      },
    } satisfies OpenClawConfig;
    const { promise: pluginReadStarted, resolve: recordPluginReadStarted } = createDeferred();
    const { promise: pluginReadGate, resolve: releasePluginRead } = createDeferred();
    const readPluginInstallRecords = vi.fn(async () => {
      recordPluginReadStarted?.();
      await pluginReadGate;
      return {};
    });
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({
        config: sourceConfig,
        hash: "replay-secret-restart",
      }),
    );
    const harness = createReloaderHarness(readSnapshot, { readPluginInstallRecords });
    await harness.reloader.ready;

    harness.emitWrite(
      makeWrite(sourceConfig, "replay-secret-restart", {
        runtimeConfig,
        afterWrite: { mode: "restart", reason: "replay source preflight" },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await pluginReadStarted;
    harness.watcher.emit("change");
    releasePluginRead();
    await flushReload(harness.reloader);

    expect(harness.onRestart).toHaveBeenCalledOnce();
    expect(harness.onRestart.mock.calls[0]?.[1]).toEqual(runtimeConfig);
    expect(harness.onRestart.mock.calls[0]?.[3]).toEqual(sourceConfig);
  });

  it.each(["external", "accepted write"] as const)(
    "rejects invalid snapshots observed after %s even when the root hash matches",
    async (state) => {
      let snapshot = makeZeroDebounceHookSnapshot("same-root-hash");
      const readSnapshot = vi.fn(async () => snapshot);
      const onConfigCandidateObserved = vi.fn();
      const harness = createReloaderHarness(readSnapshot, {
        initialConfig: state === "accepted write" ? snapshot.config : undefined,
        onConfigCandidateObserved,
      });
      await harness.reloader.ready;
      if (state !== "external") {
        harness.emitWrite(makeZeroDebounceHookWrite("same-root-hash"));
      }
      if (state === "accepted write") {
        await flushReload(harness.reloader);
        expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
        harness.onConfigAccepted.mockClear();
      }
      snapshot = { ...snapshot, valid: false };
      onConfigCandidateObserved.mockClear();
      harness.watcher.emit("change");
      expect(onConfigCandidateObserved).toHaveBeenCalledOnce();
      expect(readSnapshot).not.toHaveBeenCalled();
      await flushReload(harness.reloader);
      expect(harness.onConfigAccepted).not.toHaveBeenCalled();
      expect(harness.onRestart).not.toHaveBeenCalled();
      expect(harness.onHotReload).not.toHaveBeenCalled();
    },
  );

  it("preserves watcher echo restart intent while coalescing a newer write", async () => {
    const { promise: pluginReadStarted, resolve: recordPluginReadStarted } = createDeferred();
    const { promise: pluginReadGate, resolve: releasePluginRead } = createDeferred();
    const readPluginInstallRecords = vi.fn(async () => {
      recordPluginReadStarted();
      await pluginReadGate;
      return {};
    });
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({
        config: { gateway: { reload: {} }, hooks: { enabled: false } },
        hash: "latest-c",
      }),
    );
    const harness = createReloaderHarness(readSnapshot, { readPluginInstallRecords });
    await harness.reloader.ready;

    const pendingApplication = createRuntimeConfigWriteApplication();
    const restartIntent = { mode: "restart", reason: "committed write requires restart" } as const;
    harness.emitWrite({
      ...makeZeroDebounceHookWrite("active-a"),
      afterWrite: { mode: "none", reason: "active A intent" },
    });
    await vi.advanceTimersByTimeAsync(0);
    await pluginReadStarted;

    const latestApplication = createRuntimeConfigWriteApplication();
    harness.emitWrite(
      attachRuntimeConfigWriteApplication(
        { ...makeZeroDebounceHookWrite("pending-b"), afterWrite: restartIntent },
        pendingApplication,
      ),
    );
    harness.watcher.emit("change");
    const latestConfig = {
      gateway: { reload: {} },
      hooks: { enabled: false },
    } satisfies OpenClawConfig;
    harness.emitWrite(
      attachRuntimeConfigWriteApplication(
        {
          ...makeZeroDebounceHookWrite("latest-c"),
          snapshot: makeSnapshot({ config: latestConfig, hash: "latest-c" }),
          sourceConfig: latestConfig,
          runtimeConfig: latestConfig,
          afterWrite: { mode: "none", reason: "latest C intent" },
        },
        latestApplication,
      ),
    );
    releasePluginRead();
    try {
      await flushReload(harness.reloader);
      await expect(pendingApplication.result).resolves.toBe("superseded");
      await expect(latestApplication.result).resolves.toBe("restart-pending");
      const [restartPlan, restartedConfig] = getOnlyRestartCall(harness);
      expect(restartedConfig).toEqual(latestConfig);
      expect(restartPlan.restartReasons).toContain(restartIntent.reason);
      expect(harness.onHotReload).not.toHaveBeenCalled();
      expect(harness.onConfigApplied).not.toHaveBeenCalled();
      expect(harness.onConfigRevisionApplied).not.toHaveBeenCalled();
    } finally {
      await harness.reloader.stop();
    }
  });

  it.each(["watcher", "new write"] as const)(
    "preserves required restart after failed admission through %s",
    async (retry) => {
      const readSnapshot = vi.fn(async () => makeZeroDebounceHookSnapshot("replay-retry"));
      const harness = createReloaderHarness(readSnapshot);
      await harness.reloader.ready;
      harness.onRestart.mockRejectedValueOnce(new Error("restart admission failed"));

      harness.emitWrite({
        ...makeZeroDebounceHookWrite("replay-retry"),
        afterWrite: { mode: "restart", reason: "retry original intent" },
      });
      await flushWatcherChange(harness);

      if (retry === "new write") {
        const newer: ConfigWriteNotification = {
          ...makeZeroDebounceHookWrite("replay-retry-new"),
          afterWrite: { mode: "none", reason: "newer intent" },
        };
        readSnapshot.mockResolvedValue(newer.snapshot);
        harness.emitWrite(newer);
        await flushReload(harness.reloader);
      } else {
        await flushWatcherChange(harness);
      }

      expect(readSnapshot).toHaveBeenCalledTimes(retry === "watcher" ? 1 : 0);
      expect(harness.onRestart).toHaveBeenCalledTimes(2);
      expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
      expect(harness.onHotReload).not.toHaveBeenCalled();

      await harness.reloader.stop();
    },
  );

  it("retries a failed RPC write under independent watcher admission after its request settles", async () => {
    const readSnapshot = vi.fn(async () => makeZeroDebounceHookSnapshot("direct-retry"));
    const harness = createReloaderHarness(readSnapshot, {
      runTransaction: runWithGatewayIndependentRootWorkAdmission,
    });
    await harness.reloader.ready;
    harness.onRestart.mockRejectedValueOnce(new Error("restart admission failed"));
    const request = tryBeginGatewayRootWorkAdmission();
    if (!request) {
      throw new Error("expected gateway request admission");
    }
    try {
      await request.run(async () => {
        const continuation = captureGatewayRootWorkAdmissionContinuationScope();
        if (!continuation) {
          throw new Error("expected originating gateway request continuation");
        }
        const application = createRuntimeConfigWriteApplication(continuation.run);
        harness.emitWrite(
          attachRuntimeConfigWriteApplication(
            {
              ...makeZeroDebounceHookWrite("direct-retry"),
              afterWrite: { mode: "restart", reason: "retry direct intent" },
            },
            application,
          ),
        );
        await flushReload(harness.reloader);
        await expect(application.result).resolves.toBe("failed");
      });
    } finally {
      request.release();
    }

    await flushWatcherChange(harness);

    expect(readSnapshot).toHaveBeenCalledOnce();
    expect(harness.onRestart).toHaveBeenCalledTimes(2);
    expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
    expect(harness.onHotReload).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "plans authored install changes without masking timestamp collisions (collision: %s)",
    async (collision) => {
      const baseInstall = {
        source: "npm" as const,
        spec: "@martian-engineering/lossless-claw",
        installPath: "/tmp/lossless-claw",
        installedAt: "2026-04-22T00:00:00.000Z",
        resolvedAt: "2026-04-22T00:00:00.000Z",
      };
      const sourceConfig: OpenClawConfig = {
        gateway: { reload: {}, auth: { mode: "token" } },
        plugins: { installs: { lossless: baseInstall } },
      };
      const nextSourceConfig: OpenClawConfig = {
        ...sourceConfig,
        plugins: {
          installs: {
            lossless: {
              ...baseInstall,
              installedAt: collision ? baseInstall.installedAt : "2026-04-22T00:01:00.000Z",
              resolvedAt: "2026-04-22T00:01:00.000Z",
            },
            ...(collision ? { "lossless.resolvedAt": { source: "npm" as const } } : {}),
          },
        },
      };
      const snapshot = makeSnapshot({ config: nextSourceConfig, hash: "plugin-install-1" });
      const harness = createReloaderHarness(async () => snapshot, {
        initialCompareConfig: sourceConfig,
      });
      await harness.reloader.ready;
      harness.emitWrite(
        makeWrite(nextSourceConfig, "plugin-install-1", {
          snapshot,
          runtimeConfig: {
            ...nextSourceConfig,
            gateway: { reload: {}, auth: { mode: "token", token: "runtime" } },
            plugins: {
              ...nextSourceConfig.plugins,
              entries: { firecrawl: { config: { webFetch: { provider: "firecrawl" } } } },
            },
          },
        }),
      );
      await flushReload(harness.reloader);

      expect(harness.onRestart).not.toHaveBeenCalled();
      if (collision) {
        const [plan, nextConfig] = getOnlyHotReloadCall(harness);
        expect(plan.changedPaths).toEqual([
          "plugins.installs.lossless.resolvedAt",
          "plugins.installs.lossless.resolvedAt",
        ]);
        expect(plan.restartGateway).toBe(false);
        expect(plan.hotReasons).toEqual([
          "plugins.installs.lossless.resolvedAt",
          "plugins.installs.lossless.resolvedAt",
        ]);
        expect(nextConfig.plugins?.installs?.["lossless.resolvedAt"]?.source).toBe("npm");
      } else {
        expect(harness.onHotReload).not.toHaveBeenCalled();
        expect(
          harness.log.info.mock.calls.some(([message]) => message.includes("gateway.auth.token")),
        ).toBe(false);
      }
    },
  );

  it("preserves the completed watcher receipt for an exact install handoff", async () => {
    const root = tempDirs.make("openclaw-reload-completed-install-");
    const pluginRoot = nodePath.join(root, "plugin");
    await mkdir(pluginRoot);
    const source = nodePath.join(pluginRoot, "index.js");
    await writeFile(source, "export default {};\n");
    const artifact = capturePluginGenerationArtifact(pluginRoot);
    artifact.dispose();
    const sourceDigests = { notes: artifact.sourceDigest };
    const registry = createTestRegistry();
    const record = createPluginRecord({
      id: "notes",
      source,
      rootDir: pluginRoot,
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    registry.plugins.push(record);
    const instance = new PluginInstance("notes", { record, registry });
    instance.sourceDigest = sourceDigests.notes;
    const metadata = createPluginMetadataSnapshotFixture({
      plugins: [{ id: "notes", rootDir: pluginRoot, source, origin: "global" }],
    });
    const records = { notes: { source: "path" as const, installPath: pluginRoot } };
    const config: OpenClawConfig = { plugins: { entries: { notes: { enabled: true } } } };
    const snapshot = makeSnapshot({
      config,
      hash: "installed-notes",
    });
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const harness = createReloaderHarness(async () => snapshot, {
        readPluginInstallRecords: async () => records,
        onHotReload: async (plan, next, ownership) => {
          setActivePluginRegistry(registry);
          setCurrentPluginMetadataSnapshotState(
            metadata,
            "installed-notes",
            undefined,
            undefined,
            undefined,
            "gateway",
          );
          ownership.markRuntimeCommitted(next, plan);
          return {
            status: "applied",
            runtime: {
              operationId: plan.pluginLifecycle?.operationId ?? "watcher-install",
              generation: getPluginRuntimeGeneration(),
              pluginIds: ["notes"],
              sourceDigests,
              warnings: ["Retired source cleanup is deferred."],
            },
          };
        },
      });
      await harness.reloader.ready;
      try {
        harness.watcher.emit("change");
        await vi.advanceTimersByTimeAsync(1);
        await flushReload(harness.reloader);
        const completed = await harness.onHotReload.mock.results[0]?.value;
        expect(completed).toHaveProperty("runtime.operationId", "watcher-install");
        if (typeof completed !== "object" || completed.status !== "applied") {
          throw new Error("expected the watcher runtime application");
        }
        const request = {
          config,
          pluginIds: ["notes"],
          reason: "reload" as const,
          expectedInstallHashes: { notes: hashStableJson(records.notes) },
          expectedSourceDigests: sourceDigests,
        };
        const application = harness.reloader.applyPluginLifecycleChange(request);
        await expect(application).resolves.toBe(completed.runtime);
        expect(harness.onHotReload).toHaveBeenCalledOnce();
      } finally {
        await harness.reloader.stop();
        await instance.dispose();
        resetPluginRuntimeStateForTest();
      }
    });
  });

  it.each(["shutdown", "writer handoff"] as const)(
    "waits outside the config queue for an unfinished install batch (%s)",
    async (completion) => {
      vi.useRealTimers();
      const root = tempDirs.make("openclaw-reload-install-batch-");
      await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
        let sourceConfig: OpenClawConfig = { plugins: { entries: { first: { enabled: true } } } };
        const readSnapshot = vi.fn(async () =>
          makeSnapshot({
            config: sourceConfig,
            hash: "batch-source",
          }),
        );
        const harness = createReloaderHarness(readSnapshot, {
          onHotReload: async (plan, next, ownership) => {
            ownership.markRuntimeCommitted(next, plan);
            return {
              status: "applied",
              runtime: {
                operationId: plan.pluginLifecycle?.operationId ?? "watcher",
                generation: getPluginRuntimeGeneration(),
                pluginIds: ["first", "second"],
              },
            };
          },
        });
        await harness.reloader.ready;
        try {
          await withPluginLifecycleLease({}, async () => {
            // The CLI is reviewing the next requirement after committing the first one.
            harness.watcher.emit("change");
            await delay(100);
            expect(readSnapshot).not.toHaveBeenCalled();
            expect(harness.onHotReload).not.toHaveBeenCalled();
            if (completion === "shutdown") {
              await harness.reloader.stop();
              return;
            }
            sourceConfig = {
              plugins: { entries: { first: { enabled: true }, second: { enabled: true } } },
            };
            await expect(
              harness.reloader.applyPluginLifecycleChange({
                config: sourceConfig,
                pluginIds: ["first", "second"],
                reason: "reload",
              }),
            ).resolves.toHaveProperty("pluginIds", ["first", "second"]);
          });
          await waitForReloadState(() => !harness.reloader.isReloading());
          if (completion !== "shutdown") {
            expect(harness.onHotReload).toHaveBeenCalledOnce();
            expect(harness.onHotReload.mock.calls[0]?.[1]).toBe(sourceConfig);
          } else {
            expect(readSnapshot).not.toHaveBeenCalled();
          }
        } finally {
          await harness.reloader.stop();
        }
      });
    },
  );

  it.each(["uninstall"] as const)(
    "captures candidate install records before an initial watcher echo (%s)",
    async (reason) => {
      const config: OpenClawConfig = { gateway: { reload: {} } };
      const records: Record<string, PluginInstallRecord> = {
        notes: { source: "npm", spec: "notes@1", installPath: "/tmp/openclaw/plugins/notes" },
      };
      const snapshot = makeSnapshot({
        config,
        hash: "committed-source",
      });
      let emitEcho = () => {};
      const readSnapshot = vi.fn(async () => {
        if (readSnapshot.mock.calls.length === 1) {
          emitEcho();
        }
        return snapshot;
      });
      const runtime = { operationId: "ledger-change", generation: 2, pluginIds: ["notes"] };
      const harness = createReloaderHarness(readSnapshot, {
        initialConfig: config,
        initialPluginInstallRecords: records,
        readPluginInstallRecords: async () => ({}),
        onHotReload: async (plan, nextConfig, ownership) => {
          ownership.markRuntimeCommitted(nextConfig, plan);
          return { status: "applied", runtime };
        },
      });
      emitEcho = () => harness.watcher.emit("change");
      await harness.reloader.ready;
      try {
        await expect(
          harness.reloader.applyPluginLifecycleChange({ config, pluginIds: ["notes"], reason }),
        ).resolves.toEqual(runtime);
        expect(harness.onHotReload).toHaveBeenCalledOnce();
        expect(getOnlyHotReloadCall(harness)[0].changedPaths).toEqual(["plugins.installs.notes"]);
        await flushReload(harness.reloader);
        expect(harness.onHotReload).toHaveBeenCalledOnce();
        expect(harness.onRestart).not.toHaveBeenCalled();
      } finally {
        await harness.reloader.stop();
      }
    },
  );

  it.each(["off"] as const)(
    "applies explicit metadata through the hot owner without replaying watcher echoes (%s)",
    async (mode) => {
      const activeConfig: OpenClawConfig = {
        gateway: { reload: { mode } },
      };
      const installRecords = {
        brave: {
          source: "npm",
          spec: "@openclaw/brave",
          installPath: "/tmp/openclaw/plugins/brave",
        },
      } satisfies Record<string, PluginInstallRecord>;
      const readSnapshot = vi.fn(async () =>
        makeSnapshot({
          config: activeConfig,
          hash: "unchanged-config",
        }),
      );
      const readPluginInstallRecords = vi.fn(async () => ({ ...installRecords }));
      const harness = createReloaderHarness(readSnapshot, {
        initialConfig: activeConfig,
        initialCompareConfig: activeConfig,
        initialPluginInstallRecords: installRecords,
        readPluginInstallRecords,
        onHotReload: async (plan, nextConfig, ownership) => {
          ownership.markRuntimeCommitted(nextConfig, plan);
          return {
            status: "applied",
            runtime: { operationId: "metadata-refresh", generation: 2, pluginIds: ["brave"] },
          };
        },
      });
      await harness.reloader.ready;
      const startupMetadata = createPluginMetadataSnapshotFixture();
      setCurrentPluginMetadataSnapshotState(startupMetadata, "startup-metadata");

      const application = harness.reloader.applyPluginLifecycleChange({
        config: activeConfig,
        pluginIds: ["brave"],
        reason: "metadata",
      });
      expect(getCurrentPluginMetadataSnapshotState().snapshot).toBe(startupMetadata);
      await application;

      expect(getCurrentPluginMetadataSnapshotState().snapshot).toBe(startupMetadata);
      const [plan, nextConfig] = getOnlyHotReloadCall(harness);
      expect(plan.changedPaths).toEqual([]);
      expect(plan.restartGateway).toBe(false);
      expect(plan.pluginLifecycle).toMatchObject({ pluginIds: ["brave"], reason: "metadata" });
      expect(plan.reloadPlugins).toBe(true);
      expect(plan.disposeMcpRuntimes).toBe(false);
      expect(nextConfig).toBe(activeConfig);
      expect(getCurrentPluginMetadataSnapshotState().snapshot).toBe(startupMetadata);

      // The explicit receipt completes the operation; its unchanged watcher echo is inert.
      harness.watcher.emit("change");
      await flushReload(harness.reloader);
      expect(harness.onHotReload).toHaveBeenCalledOnce();
      expect(harness.onRestart).not.toHaveBeenCalled();
      expect(getCurrentPluginMetadataSnapshotState().snapshot).toBe(startupMetadata);

      await harness.reloader.stop();
    },
  );
});

describe("startGatewayConfigReloader skills invalidation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSkillsRefreshStateForTest();
  });

  afterEach(async () => {
    await closeTestConfigReloaders();
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetSkillsRefreshStateForTest();
  });

  it("bumps the skills snapshot version when skills.allowBundled changes", async () => {
    const before = getSkillsSnapshotVersion();
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValueOnce(
      makeSnapshot({
        config: {
          gateway: { reload: {} },
          skills: { allowBundled: ["gog"] },
        },
        hash: "skills-change-1",
      }),
    );
    const { watcher, log, reloader } = createReloaderHarness(readSnapshot);
    await reloader.ready;

    watcher.emit("change");
    await flushReload(reloader);

    const after = getSkillsSnapshotVersion();
    expect(after).toBeGreaterThan(before);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("skills snapshot invalidated by config change"),
    );

    await reloader.stop();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
