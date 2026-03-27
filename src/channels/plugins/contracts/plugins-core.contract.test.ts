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

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
    clearPluginDiscoveryCache();
    clearPluginManifestRegistryCache();
  });

  it("sorts channel plugins by configured order", () => {
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
    const pluginIds = listChannelPlugins().map((plugin) => plugin.id);
    expect(pluginIds).toEqual(["demo-first", "demo-middle", "demo-last"]);
  });

  it("refreshes cached channel lookups when the same registry instance is re-activated", () => {
    const registry = createTestRegistry([
      {
        pluginId: "demo-alpha",
        plugin: createPlugin("demo-alpha"),
        source: "test",
      },
    ]);
    setActivePluginRegistry(registry, "registry-test");
    expect(listChannelPlugins().map((plugin) => plugin.id)).toEqual(["demo-alpha"]);

    registry.channels = [
      {
        pluginId: "demo-beta",
        plugin: createPlugin("demo-beta"),
        source: "test",
      },
    ] as typeof registry.channels;
    setActivePluginRegistry(registry, "registry-test");

    expect(listChannelPlugins().map((plugin) => plugin.id)).toEqual(["demo-beta"]);
  });
});

describe("channel plugin catalog", () => {
  it("includes external catalog entries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-"));
    const catalogPath = path.join(dir, "catalog.json");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [
          {
            name: "@openclaw/demo-channel",
            openclaw: {
              channel: {
                id: "demo-channel",
                label: "Demo Channel",
                selectionLabel: "Demo Channel",
                docsPath: "/channels/demo-channel",
                blurb: "Demo entry",
                order: 999,
              },
              install: {
                npmSpec: "@openclaw/demo-channel",
              },
            },
          },
        ],
      }),
    );

    const ids = listChannelPluginCatalogEntries({ catalogPaths: [catalogPath] }).map(
      (entry) => entry.id,
    );
    expect(ids).toContain("demo-channel");
  });

  it("preserves plugin ids when they differ from channel ids", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-catalog-state-"));
    const pluginDir = path.join(stateDir, "extensions", "demo-channel-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@vendor/demo-channel-plugin",
        openclaw: {
          extensions: ["./index.js"],
          channel: {
            id: "demo-channel",
            label: "Demo Channel",
            selectionLabel: "Demo Channel",
            docsPath: "/channels/demo-channel",
            blurb: "Demo channel",
          },
          install: {
            npmSpec: "@vendor/demo-channel-plugin",
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "@vendor/demo-runtime",
        configSchema: {},
      }),
    );
    fs.writeFileSync(path.join(pluginDir, "index.js"), "module.exports = {}", "utf-8");

    const entry = listChannelPluginCatalogEntries({
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
      },
    }).find((item) => item.id === "demo-channel");

    expect(entry?.pluginId).toBe("@vendor/demo-runtime");
  });

  it("uses the provided env for external catalog path resolution", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-home-"));
    const catalogPath = path.join(home, "catalog.json");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [
          {
            name: "@openclaw/env-demo-channel",
            openclaw: {
              channel: {
                id: "env-demo-channel",
                label: "Env Demo Channel",
                selectionLabel: "Env Demo Channel",
                docsPath: "/channels/env-demo-channel",
                blurb: "Env demo entry",
                order: 1000,
              },
              install: {
                npmSpec: "@openclaw/env-demo-channel",
              },
            },
          },
        ],
      }),
    );

    const ids = listChannelPluginCatalogEntries({
      env: {
        ...process.env,
        OPENCLAW_PLUGIN_CATALOG_PATHS: "~/catalog.json",
        OPENCLAW_HOME: home,
        HOME: home,
      },
    }).map((entry) => entry.id);

    expect(ids).toContain("env-demo-channel");
  });

  it("uses the provided env for default catalog paths", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-state-"));
    const catalogPath = path.join(stateDir, "plugins", "catalog.json");
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [
          {
            name: "@openclaw/default-env-demo",
            openclaw: {
              channel: {
                id: "default-env-demo",
                label: "Default Env Demo",
                selectionLabel: "Default Env Demo",
                docsPath: "/channels/default-env-demo",
                blurb: "Default env demo entry",
              },
              install: {
                npmSpec: "@openclaw/default-env-demo",
              },
            },
          },
        ],
      }),
    );

    const ids = listChannelPluginCatalogEntries({
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      },
    }).map((entry) => entry.id);

    expect(ids).toContain("default-env-demo");
  });

  it("keeps discovered plugins ahead of external catalog overrides", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-state-"));
    const pluginDir = path.join(stateDir, "extensions", "demo-channel-plugin");
    const catalogPath = path.join(stateDir, "catalog.json");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@vendor/demo-channel-plugin",
        openclaw: {
          extensions: ["./index.js"],
          channel: {
            id: "demo-channel",
            label: "Demo Channel Runtime",
            selectionLabel: "Demo Channel Runtime",
            docsPath: "/channels/demo-channel",
            blurb: "discovered plugin",
          },
          install: {
            npmSpec: "@vendor/demo-channel-plugin",
          },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "@vendor/demo-channel-runtime",
        configSchema: {},
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(pluginDir, "index.js"), "module.exports = {}", "utf8");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [
          {
            name: "@vendor/demo-channel-catalog",
            openclaw: {
              channel: {
                id: "demo-channel",
                label: "Demo Channel Catalog",
                selectionLabel: "Demo Channel Catalog",
                docsPath: "/channels/demo-channel",
                blurb: "external catalog",
              },
              install: {
                npmSpec: "@vendor/demo-channel-catalog",
              },
            },
          },
        ],
      }),
      "utf8",
    );

    const entry = listChannelPluginCatalogEntries({
      catalogPaths: [catalogPath],
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        CLAWDBOT_STATE_DIR: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
      },
    }).find((item) => item.id === "demo-channel");

    expect(entry?.install.npmSpec).toBe("@vendor/demo-channel-plugin");
    expect(entry?.meta.label).toBe("Demo Channel Runtime");
    expect(entry?.pluginId).toBe("@vendor/demo-channel-runtime");
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
  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
    clearPluginDiscoveryCache();
    clearPluginManifestRegistryCache();
  });

  it("loads channel plugins from the active registry", async () => {
    setActivePluginRegistry(registryWithDemoLoader);
    const plugin = await loadChannelPlugin("demo-loader");
    expect(plugin).toBe(demoLoaderPlugin);
  });

  it("loads outbound adapters from registered plugins", async () => {
    setActivePluginRegistry(registryWithDemoLoader);
    const outbound = await loadChannelOutboundAdapter("demo-loader");
    expect(outbound).toBe(demoOutbound);
  });

  it("refreshes cached plugin values when registry changes", async () => {
    setActivePluginRegistry(registryWithDemoLoader);
    expect(await loadChannelPlugin("demo-loader")).toBe(demoLoaderPlugin);
    setActivePluginRegistry(registryWithDemoLoaderV2);
    expect(await loadChannelPlugin("demo-loader")).toBe(demoLoaderPluginV2);
  });

  it("refreshes cached outbound values when registry changes", async () => {
    setActivePluginRegistry(registryWithDemoLoader);
    expect(await loadChannelOutboundAdapter("demo-loader")).toBe(demoOutbound);
    setActivePluginRegistry(registryWithDemoLoaderV2);
    expect(await loadChannelOutboundAdapter("demo-loader")).toBe(demoOutboundV2);
  });

  it("returns undefined when plugin has no outbound adapter", async () => {
    setActivePluginRegistry(registryWithDemoLoaderNoOutbound);
    expect(await loadChannelOutboundAdapter("demo-loader")).toBeUndefined();
  });
});

describe("resolveChannelConfigWrites", () => {
  it("defaults to allow when unset", () => {
    const cfg = {};
    expect(resolveChannelConfigWrites({ cfg, channelId: demoOriginChannelId })).toBe(true);
  });

  it("blocks when channel config disables writes", () => {
    const cfg = { channels: { [demoOriginChannelId]: { configWrites: false } } };
    expect(resolveChannelConfigWrites({ cfg, channelId: demoOriginChannelId })).toBe(false);
  });

  it("account override wins over channel default", () => {
    const cfg = makeDemoConfigWritesCfg("work");
    expect(
      resolveChannelConfigWrites({ cfg, channelId: demoOriginChannelId, accountId: "work" }),
    ).toBe(false);
  });

  it("matches account ids case-insensitively", () => {
    const cfg = makeDemoConfigWritesCfg("Work");
    expect(
      resolveChannelConfigWrites({ cfg, channelId: demoOriginChannelId, accountId: "work" }),
    ).toBe(false);
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

  it("blocks when a target account disables writes", () => {
    expectConfigWriteBlocked({
      disabledAccountId: "work",
      reason: "target-disabled",
      blockedScope: "target",
    });
  });

  it("blocks when the origin account disables writes", () => {
    expectConfigWriteBlocked({
      disabledAccountId: "default",
      reason: "origin-disabled",
      blockedScope: "origin",
    });
  });

  it("allows bypass for internal operator.admin writes", () => {
    const cfg = makeDemoConfigWritesCfg("work");
    expect(
      authorizeConfigWrite({
        cfg,
        origin: { channelId: demoOriginChannelId, accountId: "default" },
        target: resolveExplicitConfigWriteTarget({
          channelId: demoTargetChannelId,
          accountId: "work",
        }),
        allowBypass: canBypassConfigWritePolicy({
          channel: INTERNAL_MESSAGE_CHANNEL,
          gatewayClientScopes: ["operator.admin"],
        }),
      }),
    ).toEqual({ allowed: true });
  });

  it("treats non-channel config paths as global writes", () => {
    const cfg = makeDemoConfigWritesCfg("work");
    expect(
      authorizeConfigWrite({
        cfg,
        origin: { channelId: demoOriginChannelId, accountId: "default" },
        target: resolveConfigWriteTargetFromPath(["messages", "ackReaction"]),
      }),
    ).toEqual({ allowed: true });
  });

  it("rejects ambiguous channel collection writes", () => {
    expect(resolveConfigWriteTargetFromPath(["channels", "demo-channel"])).toEqual({
      kind: "ambiguous",
      scopes: [{ channelId: "demo-channel" }],
    });
    expect(resolveConfigWriteTargetFromPath(["channels", "demo-channel", "accounts"])).toEqual({
      kind: "ambiguous",
      scopes: [{ channelId: "demo-channel" }],
    });
  });

  it("resolves explicit channel and account targets", () => {
    expect(resolveExplicitConfigWriteTarget({ channelId: demoOriginChannelId })).toEqual({
      kind: "channel",
      scope: { channelId: demoOriginChannelId },
    });
    expect(
      resolveExplicitConfigWriteTarget({ channelId: demoTargetChannelId, accountId: "work" }),
    ).toEqual({
      kind: "account",
      scope: { channelId: demoTargetChannelId, accountId: "work" },
    });
  });

  it("formats denied messages consistently", () => {
    expect(
      formatConfigWriteDeniedMessage({
        result: {
          allowed: false,
          reason: "target-disabled",
          blockedScope: {
            kind: "target",
            scope: { channelId: demoTargetChannelId, accountId: "work" },
          },
        },
      }),
    ).toContain(`channels.${demoTargetChannelId}.accounts.work.configWrites=true`);
  });
});
