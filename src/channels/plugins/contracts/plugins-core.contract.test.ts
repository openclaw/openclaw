import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPluginDiscoveryCache } from "../../../plugins/discovery.js";
import { clearPluginManifestRegistryCache } from "../../../plugins/manifest-registry.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../../utils/message-channel.js";
import { listChannelPluginCatalogEntries } from "../catalog.js";
import {
  authorizeConfigWrite,
  canBypassConfigWritePolicy,
  formatConfigWriteDeniedMessage,
  resolveExplicitConfigWriteTarget,
  resolveChannelConfigWrites,
  resolveConfigWriteTargetFromPath,
} from "../config-writes.js";
import { listChannelPlugins } from "../index.js";
import { loadChannelPlugin } from "../load.js";
import { loadChannelOutboundAdapter } from "../outbound/load.js";
import type { ChannelOutboundAdapter, ChannelPlugin } from "../types.js";

describe("channel plugin registry", () => {
  const emptyRegistry = createTestRegistry([]);

  const createPlugin = (id: string, order?: number): ChannelPlugin => ({
    id,
    meta: {
      id,
      label: id,
      selectionLabel: id,
      docsPath: `/channels/${id}`,
      blurb: "test",
      ...(order === undefined ? {} : { order }),
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
    },
  });

  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  function expectListedChannelPluginIds(expectedIds: string[]) {
    expect(listChannelPlugins().map((plugin) => plugin.id)).toEqual(expectedIds);
  }

  function expectRegistryActivationCase(run: () => void) {
    run();
  }

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
    clearPluginDiscoveryCache();
    clearPluginManifestRegistryCache();
  });

  it.each([
    {
      name: "sorts channel plugins by configured order",
      run: () => {
        const orderedPlugins: Array<[string, number]> = [
          ["demo-middle", 20],
          ["demo-first", 10],
          ["demo-last", 30],
        ];
        const registry = createTestRegistry(
          orderedPlugins.map(([id, order]) => ({
            pluginId: id,
            plugin: createPlugin(id, order),
            source: "test",
          })),
        );
        setActivePluginRegistry(registry);
        expectListedChannelPluginIds(["demo-first", "demo-middle", "demo-last"]);
      },
    },
    {
      name: "refreshes cached channel lookups when the same registry instance is re-activated",
      run: () => {
        const registry = createTestRegistry([
          {
            pluginId: "demo-alpha",
            plugin: createPlugin("demo-alpha"),
            source: "test",
          },
        ]);
        setActivePluginRegistry(registry, "registry-test");
        expectListedChannelPluginIds(["demo-alpha"]);

        registry.channels = [
          {
            pluginId: "demo-beta",
            plugin: createPlugin("demo-beta"),
            source: "test",
          },
        ] as typeof registry.channels;
        setActivePluginRegistry(registry, "registry-test");

        expectListedChannelPluginIds(["demo-beta"]);
      },
    },
  ] as const)("$name", ({ run }) => {
    expectRegistryActivationCase(run);
  });
});

describe("channel plugin catalog", () => {
  function createCatalogEntry(params: {
    packageName: string;
    channelId: string;
    label: string;
    blurb: string;
    order?: number;
  }) {
    return {
      name: params.packageName,
      openclaw: {
        channel: {
          id: params.channelId,
          label: params.label,
          selectionLabel: params.label,
          docsPath: `/channels/${params.channelId}`,
          blurb: params.blurb,
          ...(params.order === undefined ? {} : { order: params.order }),
        },
        install: {
          npmSpec: params.packageName,
        },
      },
    };
  }

  function writeCatalogFile(catalogPath: string, entry: Record<string, unknown>) {
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [entry],
      }),
    );
  }

  function writeDiscoveredChannelPlugin(params: {
    stateDir: string;
    packageName: string;
    channelLabel: string;
    pluginId: string;
    blurb: string;
  }) {
    const pluginDir = path.join(params.stateDir, "extensions", "demo-channel-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: params.packageName,
        openclaw: {
          extensions: ["./index.js"],
          channel: {
            id: "demo-channel",
            label: params.channelLabel,
            selectionLabel: params.channelLabel,
            docsPath: "/channels/demo-channel",
            blurb: params.blurb,
          },
          install: {
            npmSpec: params.packageName,
          },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: params.pluginId,
        configSchema: {},
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(pluginDir, "index.js"), "module.exports = {}", "utf8");
    return pluginDir;
  }

  function expectCatalogIdsContain(params: {
    expectedId: string;
    catalogPaths?: string[];
    env?: NodeJS.ProcessEnv;
  }) {
    const ids = listChannelPluginCatalogEntries({
      ...(params.catalogPaths ? { catalogPaths: params.catalogPaths } : {}),
      ...(params.env ? { env: params.env } : {}),
    }).map((entry) => entry.id);
    expect(ids).toContain(params.expectedId);
  }

  function findCatalogEntry(params: {
    channelId: string;
    catalogPaths?: string[];
    env?: NodeJS.ProcessEnv;
  }) {
    return listChannelPluginCatalogEntries({
      ...(params.catalogPaths ? { catalogPaths: params.catalogPaths } : {}),
      ...(params.env ? { env: params.env } : {}),
    }).find((entry) => entry.id === params.channelId);
  }

  function expectCatalogEntryMatch(params: {
    channelId: string;
    expected: Record<string, unknown>;
    catalogPaths?: string[];
    env?: NodeJS.ProcessEnv;
  }) {
    expect(
      findCatalogEntry({
        channelId: params.channelId,
        ...(params.catalogPaths ? { catalogPaths: params.catalogPaths } : {}),
        ...(params.env ? { env: params.env } : {}),
      }),
    ).toMatchObject(params.expected);
  }

  it.each([
    {
      name: "includes external catalog entries",
      setup: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-"));
        const catalogPath = path.join(dir, "catalog.json");
        writeCatalogFile(
          catalogPath,
          createCatalogEntry({
            packageName: "@openclaw/demo-channel",
            channelId: "demo-channel",
            label: "Demo Channel",
            blurb: "Demo entry",
            order: 999,
          }),
        );
        return {
          channelId: "demo-channel",
          catalogPaths: [catalogPath],
          expected: { id: "demo-channel" },
        };
      },
    },
    {
      name: "preserves plugin ids when they differ from channel ids",
      setup: () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-catalog-state-"));
        writeDiscoveredChannelPlugin({
          stateDir,
          packageName: "@vendor/demo-channel-plugin",
          channelLabel: "Demo Channel",
          pluginId: "@vendor/demo-runtime",
          blurb: "Demo channel",
        });
        return {
          channelId: "demo-channel",
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
          },
          expected: { pluginId: "@vendor/demo-runtime" },
        };
      },
    },
    {
      name: "keeps discovered plugins ahead of external catalog overrides",
      setup: () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-state-"));
        const catalogPath = path.join(stateDir, "catalog.json");
        writeDiscoveredChannelPlugin({
          stateDir,
          packageName: "@vendor/demo-channel-plugin",
          channelLabel: "Demo Channel Runtime",
          pluginId: "@vendor/demo-channel-runtime",
          blurb: "discovered plugin",
        });
        writeCatalogFile(
          catalogPath,
          createCatalogEntry({
            packageName: "@vendor/demo-channel-catalog",
            channelId: "demo-channel",
            label: "Demo Channel Catalog",
            blurb: "external catalog",
          }),
        );
        return {
          channelId: "demo-channel",
          catalogPaths: [catalogPath],
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: stateDir,
            CLAWDBOT_STATE_DIR: undefined,
            OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
          },
          expected: {
            install: { npmSpec: "@vendor/demo-channel-plugin" },
            meta: { label: "Demo Channel Runtime" },
            pluginId: "@vendor/demo-channel-runtime",
          },
        };
      },
    },
  ] as const)("$name", ({ setup }) => {
    const setupResult = setup();
    const { channelId, expected } = setupResult;
    expectCatalogEntryMatch({
      channelId,
      expected,
      ...("catalogPaths" in setupResult ? { catalogPaths: setupResult.catalogPaths } : {}),
      ...("env" in setupResult ? { env: setupResult.env } : {}),
    });
  });

  it.each([
    {
      name: "uses the provided env for external catalog path resolution",
      setup: () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-home-"));
        const catalogPath = path.join(home, "catalog.json");
        writeCatalogFile(
          catalogPath,
          createCatalogEntry({
            packageName: "@openclaw/env-demo-channel",
            channelId: "env-demo-channel",
            label: "Env Demo Channel",
            blurb: "Env demo entry",
            order: 1000,
          }),
        );
        return {
          env: {
            ...process.env,
            OPENCLAW_PLUGIN_CATALOG_PATHS: "~/catalog.json",
            OPENCLAW_HOME: home,
            HOME: home,
          },
          expectedId: "env-demo-channel",
        };
      },
    },
    {
      name: "uses the provided env for default catalog paths",
      setup: () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-state-"));
        const catalogPath = path.join(stateDir, "plugins", "catalog.json");
        fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
        writeCatalogFile(
          catalogPath,
          createCatalogEntry({
            packageName: "@openclaw/default-env-demo",
            channelId: "default-env-demo",
            label: "Default Env Demo",
            blurb: "Default env demo entry",
          }),
        );
        return {
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: stateDir,
          },
          expectedId: "default-env-demo",
        };
      },
    },
  ] as const)("$name", ({ setup }) => {
    const { env, expectedId } = setup();
    expectCatalogIdsContain({ env, expectedId });
  });
});

const emptyRegistry = createTestRegistry([]);

const demoOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async () => ({ channel: "demo-loader", messageId: "m1" }),
  sendMedia: async () => ({ channel: "demo-loader", messageId: "m2" }),
};

const demoLoaderPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "demo-loader",
    label: "Demo Loader",
    config: { listAccountIds: () => [], resolveAccount: () => ({}) },
  }),
  outbound: demoOutbound,
};

const registryWithDemoLoader = createTestRegistry([
  { pluginId: "demo-loader", plugin: demoLoaderPlugin, source: "test" },
]);

const demoOutboundV2: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async () => ({ channel: "demo-loader", messageId: "m3" }),
  sendMedia: async () => ({ channel: "demo-loader", messageId: "m4" }),
};

const demoLoaderPluginV2 = createOutboundTestPlugin({
  id: "demo-loader",
  label: "Demo Loader",
  outbound: demoOutboundV2,
});

const registryWithDemoLoaderV2 = createTestRegistry([
  { pluginId: "demo-loader", plugin: demoLoaderPluginV2, source: "test-v2" },
]);

const demoNoOutboundPlugin = createChannelTestPluginBase({
  id: "demo-loader",
  label: "Demo Loader",
});

const registryWithDemoLoaderNoOutbound = createTestRegistry([
  { pluginId: "demo-loader", plugin: demoNoOutboundPlugin, source: "test-no-outbound" },
]);

const demoOriginChannelId = "demo-origin";
const demoTargetChannelId = "demo-target";

function makeDemoConfigWritesCfg(accountIdKey: string) {
  return {
    channels: {
      [demoOriginChannelId]: {
        configWrites: true,
        accounts: {
          [accountIdKey]: { configWrites: false },
        },
      },
      [demoTargetChannelId]: {
        configWrites: true,
        accounts: {
          [accountIdKey]: { configWrites: false },
        },
      },
    },
  };
}

describe("channel plugin loader", () => {
  async function expectLoadedPluginCase(params: {
    registry: Parameters<typeof setActivePluginRegistry>[0];
    expectedPlugin: ChannelPlugin;
  }) {
    setActivePluginRegistry(params.registry);
    expect(await loadChannelPlugin("demo-loader")).toBe(params.expectedPlugin);
  }

  async function expectLoadedOutboundCase(params: {
    registry: Parameters<typeof setActivePluginRegistry>[0];
    expectedOutbound: ChannelOutboundAdapter | undefined;
  }) {
    setActivePluginRegistry(params.registry);
    expect(await loadChannelOutboundAdapter("demo-loader")).toBe(params.expectedOutbound);
  }

  async function expectReloadedLoaderCase(params: {
    load: typeof loadChannelPlugin | typeof loadChannelOutboundAdapter;
    firstRegistry: Parameters<typeof setActivePluginRegistry>[0];
    secondRegistry: Parameters<typeof setActivePluginRegistry>[0];
    firstExpected: ChannelPlugin | ChannelOutboundAdapter | undefined;
    secondExpected: ChannelPlugin | ChannelOutboundAdapter | undefined;
  }) {
    setActivePluginRegistry(params.firstRegistry);
    expect(await params.load("demo-loader")).toBe(params.firstExpected);
    setActivePluginRegistry(params.secondRegistry);
    expect(await params.load("demo-loader")).toBe(params.secondExpected);
  }

  async function expectOutboundAdapterMissingCase(
    registry: Parameters<typeof setActivePluginRegistry>[0],
  ) {
    setActivePluginRegistry(registry);
    expect(await loadChannelOutboundAdapter("demo-loader")).toBeUndefined();
  }

  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
    clearPluginDiscoveryCache();
    clearPluginManifestRegistryCache();
  });

  it.each([
    {
      name: "loads channel plugins from the active registry",
      kind: "plugin" as const,
      registry: registryWithDemoLoader,
      expectedPlugin: demoLoaderPlugin,
    },
    {
      name: "loads outbound adapters from registered plugins",
      kind: "outbound" as const,
      registry: registryWithDemoLoader,
      expectedOutbound: demoOutbound,
    },
    {
      name: "refreshes cached plugin values when registry changes",
      kind: "reload-plugin" as const,
      firstRegistry: registryWithDemoLoader,
      secondRegistry: registryWithDemoLoaderV2,
      firstExpected: demoLoaderPlugin,
      secondExpected: demoLoaderPluginV2,
    },
    {
      name: "refreshes cached outbound values when registry changes",
      kind: "reload-outbound" as const,
      firstRegistry: registryWithDemoLoader,
      secondRegistry: registryWithDemoLoaderV2,
      firstExpected: demoOutbound,
      secondExpected: demoOutboundV2,
    },
    {
      name: "returns undefined when plugin has no outbound adapter",
      kind: "missing-outbound" as const,
      registry: registryWithDemoLoaderNoOutbound,
    },
  ] as const)("$name", async (testCase) => {
    switch (testCase.kind) {
      case "plugin":
        await expectLoadedPluginCase({
          registry: testCase.registry,
          expectedPlugin: testCase.expectedPlugin,
        });
        return;
      case "outbound":
        await expectLoadedOutboundCase({
          registry: testCase.registry,
          expectedOutbound: testCase.expectedOutbound,
        });
        return;
      case "reload-plugin":
        await expectReloadedLoaderCase({
          load: loadChannelPlugin,
          firstRegistry: testCase.firstRegistry,
          secondRegistry: testCase.secondRegistry,
          firstExpected: testCase.firstExpected,
          secondExpected: testCase.secondExpected,
        });
        return;
      case "reload-outbound":
        await expectReloadedLoaderCase({
          load: loadChannelOutboundAdapter,
          firstRegistry: testCase.firstRegistry,
          secondRegistry: testCase.secondRegistry,
          firstExpected: testCase.firstExpected,
          secondExpected: testCase.secondExpected,
        });
        return;
      case "missing-outbound":
        await expectOutboundAdapterMissingCase(testCase.registry);
        return;
    }
  });
});

describe("resolveChannelConfigWrites", () => {
  function expectResolvedChannelConfigWrites(params: {
    cfg: Record<string, unknown>;
    channelId: string;
    accountId?: string;
    expected: boolean;
  }) {
    expect(
      resolveChannelConfigWrites({
        cfg: params.cfg,
        channelId: params.channelId,
        ...(params.accountId ? { accountId: params.accountId } : {}),
      }),
    ).toBe(params.expected);
  }

  it.each([
    {
      name: "defaults to allow when unset",
      cfg: {},
      channelId: demoOriginChannelId,
      expected: true,
    },
    {
      name: "blocks when channel config disables writes",
      cfg: { channels: { [demoOriginChannelId]: { configWrites: false } } },
      channelId: demoOriginChannelId,
      expected: false,
    },
    {
      name: "account override wins over channel default",
      cfg: makeDemoConfigWritesCfg("work"),
      channelId: demoOriginChannelId,
      accountId: "work",
      expected: false,
    },
    {
      name: "matches account ids case-insensitively",
      cfg: makeDemoConfigWritesCfg("Work"),
      channelId: demoOriginChannelId,
      accountId: "work",
      expected: false,
    },
  ] as const)("$name", (testCase) => {
    expectResolvedChannelConfigWrites(testCase);
  });
});

describe("authorizeConfigWrite", () => {
  function expectConfigWriteBlocked(params: {
    disabledAccountId: string;
    reason: "target-disabled" | "origin-disabled";
    blockedScope: "target" | "origin";
  }) {
    expect(
      authorizeConfigWrite({
        cfg: makeDemoConfigWritesCfg(params.disabledAccountId),
        origin: { channelId: demoOriginChannelId, accountId: "default" },
        target: resolveExplicitConfigWriteTarget({
          channelId: params.blockedScope === "target" ? demoTargetChannelId : demoOriginChannelId,
          accountId: "work",
        }),
      }),
    ).toEqual({
      allowed: false,
      reason: params.reason,
      blockedScope: {
        kind: params.blockedScope,
        scope: {
          channelId: params.blockedScope === "target" ? demoTargetChannelId : demoOriginChannelId,
          accountId: params.blockedScope === "target" ? "work" : "default",
        },
      },
    });
  }

  function expectAuthorizedConfigWriteCase(
    input: Parameters<typeof authorizeConfigWrite>[0],
    expected: ReturnType<typeof authorizeConfigWrite>,
  ) {
    expect(authorizeConfigWrite(input)).toEqual(expected);
  }

  function expectResolvedConfigWriteTargetCase(pathSegments: readonly string[], expected: unknown) {
    expect(resolveConfigWriteTargetFromPath([...pathSegments])).toEqual(expected);
  }

  function expectExplicitConfigWriteTargetCase(
    input: Parameters<typeof resolveExplicitConfigWriteTarget>[0],
    expected: ReturnType<typeof resolveExplicitConfigWriteTarget>,
  ) {
    expect(resolveExplicitConfigWriteTarget(input)).toEqual(expected);
  }

  function expectFormattedDeniedMessage(
    result: Exclude<ReturnType<typeof authorizeConfigWrite>, { allowed: true }>,
  ) {
    expect(
      formatConfigWriteDeniedMessage({
        result,
      }),
    ).toContain(`channels.${demoTargetChannelId}.accounts.work.configWrites=true`);
  }

  it.each([
    {
      name: "blocks when a target account disables writes",
      disabledAccountId: "work",
      reason: "target-disabled",
      blockedScope: "target",
    },
    {
      name: "blocks when the origin account disables writes",
      disabledAccountId: "default",
      reason: "origin-disabled",
      blockedScope: "origin",
    },
  ] as const)("$name", (testCase) => {
    expectConfigWriteBlocked(testCase);
  });

  it.each([
    {
      name: "allows bypass for internal operator.admin writes",
      input: {
        cfg: makeDemoConfigWritesCfg("work"),
        origin: { channelId: demoOriginChannelId, accountId: "default" },
        target: resolveExplicitConfigWriteTarget({
          channelId: demoTargetChannelId,
          accountId: "work",
        }),
        allowBypass: canBypassConfigWritePolicy({
          channel: INTERNAL_MESSAGE_CHANNEL,
          gatewayClientScopes: ["operator.admin"],
        }),
      },
      expected: { allowed: true },
    },
    {
      name: "treats non-channel config paths as global writes",
      input: {
        cfg: makeDemoConfigWritesCfg("work"),
        origin: { channelId: demoOriginChannelId, accountId: "default" },
        target: resolveConfigWriteTargetFromPath(["messages", "ackReaction"]),
      },
      expected: { allowed: true },
    },
  ] as const)("$name", ({ input, expected }) => {
    expectAuthorizedConfigWriteCase(input, expected);
  });

  it.each([
    {
      name: "rejects bare channel collection writes",
      pathSegments: ["channels", "demo-channel"],
      expected: { kind: "ambiguous", scopes: [{ channelId: "demo-channel" }] },
    },
    {
      name: "rejects account collection writes",
      pathSegments: ["channels", "demo-channel", "accounts"],
      expected: { kind: "ambiguous", scopes: [{ channelId: "demo-channel" }] },
    },
  ] as const)("$name", ({ pathSegments, expected }) => {
    expectResolvedConfigWriteTargetCase(pathSegments, expected);
  });

  it.each([
    {
      name: "resolves explicit channel target",
      input: { channelId: demoOriginChannelId },
      expected: {
        kind: "channel",
        scope: { channelId: demoOriginChannelId },
      },
    },
    {
      name: "resolves explicit account target",
      input: { channelId: demoTargetChannelId, accountId: "work" },
      expected: {
        kind: "account",
        scope: { channelId: demoTargetChannelId, accountId: "work" },
      },
    },
  ] as const)("$name", ({ input, expected }) => {
    expectExplicitConfigWriteTargetCase(input, expected);
  });

  it.each([
    {
      name: "formats denied messages consistently",
      result: {
        allowed: false,
        reason: "target-disabled",
        blockedScope: {
          kind: "target",
          scope: { channelId: demoTargetChannelId, accountId: "work" },
        },
      } as const,
    },
  ] as const)("$name", ({ result }) => {
    expectFormattedDeniedMessage(result);
  });
});
