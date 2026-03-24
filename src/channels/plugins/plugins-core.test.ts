import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  listDiscordDirectoryGroupsFromConfig,
  listDiscordDirectoryPeersFromConfig,
} from "../../../extensions/discord/src/directory-config.js";
import type { DiscordProbe } from "../../../extensions/discord/src/probe.js";
import type { DiscordTokenResolution } from "../../../extensions/discord/src/token.js";
import type { IMessageProbe } from "../../../extensions/imessage/src/probe.js";
import type { SignalProbe } from "../../../extensions/signal/src/probe.js";
import {
  listSlackDirectoryGroupsFromConfig,
  listSlackDirectoryPeersFromConfig,
} from "../../../extensions/slack/src/directory-config.js";
import type { SlackProbe } from "../../../extensions/slack/src/probe.js";
import {
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
} from "../../../extensions/telegram/src/directory-config.js";
import type { TelegramProbe } from "../../../extensions/telegram/src/probe.js";
import type { TelegramTokenResolution } from "../../../extensions/telegram/src/token.js";
import {
  listWhatsAppDirectoryGroupsFromConfig,
  listWhatsAppDirectoryPeersFromConfig,
} from "../../../extensions/whatsapp/src/directory-config.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { LineProbeResult } from "../../plugin-sdk/line.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createMSTeamsTestPluginBase,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { getChannelPluginCatalogEntry, listChannelPluginCatalogEntries } from "./catalog.js";
import {
  authorizeConfigWrite,
  canBypassConfigWritePolicy,
  formatConfigWriteDeniedMessage,
  resolveExplicitConfigWriteTarget,
  resolveChannelConfigWrites,
  resolveConfigWriteTargetFromPath,
} from "./config-writes.js";
import { listChannelPlugins } from "./index.js";
import { loadChannelPlugin } from "./load.js";
import { loadChannelOutboundAdapter } from "./outbound/load.js";
import type { ChannelDirectoryEntry, ChannelOutboundAdapter, ChannelPlugin } from "./types.js";
import type { BaseProbeResult, BaseTokenResolution } from "./types.js";

describe("channel plugin registry", () => {
  const emptyRegistry = createTestRegistry([]);

  const createPlugin = (id: string): ChannelPlugin => ({
    id,
    meta: {
      id,
      label: id,
      selectionLabel: id,
      docsPath: `/channels/${id}`,
      blurb: "test",
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
  });

  it("sorts channel plugins by configured order", () => {
    const registry = createTestRegistry(
      ["slack", "telegram", "signal"].map((id) => ({
        pluginId: id,
        plugin: createPlugin(id),
        source: "test",
      })),
    );
    setActivePluginRegistry(registry);
    const pluginIds = listChannelPlugins().map((plugin) => plugin.id);
    expect(pluginIds).toEqual(["telegram", "slack", "signal"]);
  });

  it("refreshes cached channel lookups when the same registry instance is re-activated", () => {
    const registry = createTestRegistry([
      {
        pluginId: "slack",
        plugin: createPlugin("slack"),
        source: "test",
      },
    ]);
    setActivePluginRegistry(registry, "registry-test");
    expect(listChannelPlugins().map((plugin) => plugin.id)).toEqual(["slack"]);

    registry.channels = [
      {
        pluginId: "telegram",
        plugin: createPlugin("telegram"),
        source: "test",
      },
    ] as typeof registry.channels;
    setActivePluginRegistry(registry, "registry-test");

    expect(listChannelPlugins().map((plugin) => plugin.id)).toEqual(["telegram"]);
  });
});

describe("channel plugin catalog", () => {
  it("includes Microsoft Teams", () => {
    const entry = getChannelPluginCatalogEntry("msteams");
    expect(entry?.install.npmSpec).toBe("@openclaw/msteams");
    expect(entry?.meta.aliases).toContain("teams");
  });

  it("lists plugin catalog entries", () => {
    const ids = listChannelPluginCatalogEntries().map((entry) => entry.id);
    expect(ids).toContain("msteams");
  });

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

  it("includes bundled metadata-only channel entries even when the runtime entrypoint is omitted", () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-catalog-"));
    const bundledDir = path.join(packageRoot, "dist", "extensions", "whatsapp");
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(bundledDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/whatsapp",
        openclaw: {
          extensions: ["./index.js"],
          channel: {
            id: "whatsapp",
            label: "WhatsApp",
            selectionLabel: "WhatsApp (QR link)",
            detailLabel: "WhatsApp Web",
            docsPath: "/channels/whatsapp",
            blurb: "works with your own number; recommend a separate phone + eSIM.",
          },
          install: {
            npmSpec: "@openclaw/whatsapp",
            defaultChoice: "npm",
          },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(bundledDir, "openclaw.plugin.json"),
      JSON.stringify({ id: "whatsapp", channels: ["whatsapp"], configSchema: {} }),
      "utf8",
    );

    const entry = listChannelPluginCatalogEntries({
      env: {
        ...process.env,
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(packageRoot, "dist", "extensions"),
      },
    }).find((item) => item.id === "whatsapp");

    expect(entry?.install.npmSpec).toBe("@openclaw/whatsapp");
    expect(entry?.pluginId).toBe("whatsapp");
  });

  it("includes shipped official channel catalog entries when bundled metadata is omitted", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-official-catalog-"));
    const catalogPath = path.join(dir, "channel-catalog.json");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [
          {
            name: "@openclaw/whatsapp",
            openclaw: {
              channel: {
                id: "whatsapp",
                label: "WhatsApp",
                selectionLabel: "WhatsApp (QR link)",
                detailLabel: "WhatsApp Web",
                docsPath: "/channels/whatsapp",
                blurb: "works with your own number; recommend a separate phone + eSIM.",
              },
              install: {
                npmSpec: "@openclaw/whatsapp",
                defaultChoice: "npm",
              },
            },
          },
        ],
      }),
    );

    const entry = listChannelPluginCatalogEntries({
      env: {
        ...process.env,
        OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
      },
      officialCatalogPaths: [catalogPath],
    }).find((item) => item.id === "whatsapp");

    expect(entry?.install.npmSpec).toBe("@openclaw/whatsapp");
    expect(entry?.pluginId).toBeUndefined();
  });

  it("lets external catalogs override shipped fallback channel metadata", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-fallback-catalog-"));
    const bundledDir = path.join(dir, "dist", "extensions", "whatsapp");
    const officialCatalogPath = path.join(dir, "channel-catalog.json");
    const externalCatalogPath = path.join(dir, "catalog.json");
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.writeFileSync(
      path.join(bundledDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/whatsapp",
        openclaw: {
          channel: {
            id: "whatsapp",
            label: "WhatsApp Bundled",
            selectionLabel: "WhatsApp Bundled",
            docsPath: "/channels/whatsapp",
            blurb: "bundled fallback",
          },
          install: {
            npmSpec: "@openclaw/whatsapp",
          },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      officialCatalogPath,
      JSON.stringify({
        entries: [
          {
            name: "@openclaw/whatsapp",
            openclaw: {
              channel: {
                id: "whatsapp",
                label: "WhatsApp Official",
                selectionLabel: "WhatsApp Official",
                docsPath: "/channels/whatsapp",
                blurb: "official fallback",
              },
              install: {
                npmSpec: "@openclaw/whatsapp",
              },
            },
          },
        ],
      }),
      "utf8",
    );
    fs.writeFileSync(
      externalCatalogPath,
      JSON.stringify({
        entries: [
          {
            name: "@vendor/whatsapp-fork",
            openclaw: {
              channel: {
                id: "whatsapp",
                label: "WhatsApp Fork",
                selectionLabel: "WhatsApp Fork",
                docsPath: "/channels/whatsapp",
                blurb: "external override",
              },
              install: {
                npmSpec: "@vendor/whatsapp-fork",
              },
            },
          },
        ],
      }),
      "utf8",
    );

    const entry = listChannelPluginCatalogEntries({
      catalogPaths: [externalCatalogPath],
      officialCatalogPaths: [officialCatalogPath],
      env: {
        ...process.env,
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(dir, "dist", "extensions"),
      },
    }).find((item) => item.id === "whatsapp");

    expect(entry?.install.npmSpec).toBe("@vendor/whatsapp-fork");
    expect(entry?.meta.label).toBe("WhatsApp Fork");
    expect(entry?.pluginId).toBeUndefined();
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

const msteamsOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async () => ({ channel: "msteams", messageId: "m1" }),
  sendMedia: async () => ({ channel: "msteams", messageId: "m2" }),
};

const msteamsPlugin: ChannelPlugin = {
  ...createMSTeamsTestPluginBase(),
  outbound: msteamsOutbound,
};

const registryWithMSTeams = createTestRegistry([
  { pluginId: "msteams", plugin: msteamsPlugin, source: "test" },
]);

const msteamsOutboundV2: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async () => ({ channel: "msteams", messageId: "m3" }),
  sendMedia: async () => ({ channel: "msteams", messageId: "m4" }),
};

const msteamsPluginV2 = createOutboundTestPlugin({
  id: "msteams",
  label: "Microsoft Teams",
  outbound: msteamsOutboundV2,
});

const registryWithMSTeamsV2 = createTestRegistry([
  { pluginId: "msteams", plugin: msteamsPluginV2, source: "test-v2" },
]);

const mstNoOutboundPlugin = createChannelTestPluginBase({
  id: "msteams",
  label: "Microsoft Teams",
});

const registryWithMSTeamsNoOutbound = createTestRegistry([
  { pluginId: "msteams", plugin: mstNoOutboundPlugin, source: "test-no-outbound" },
]);

function makeSlackConfigWritesCfg(accountIdKey: string) {
  return {
    channels: {
      slack: {
        configWrites: true,
        accounts: {
          [accountIdKey]: { configWrites: false },
        },
      },
    },
  };
}

type DirectoryListFn = (params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
}) => Promise<ChannelDirectoryEntry[]>;

async function listDirectoryEntriesWithDefaults(listFn: DirectoryListFn, cfg: OpenClawConfig) {
  return await listFn({
    cfg,
    accountId: "default",
    query: null,
    limit: null,
  });
}

async function expectDirectoryIds(
  listFn: DirectoryListFn,
  cfg: OpenClawConfig,
  expected: string[],
  options?: { sorted?: boolean },
) {
  const entries = await listDirectoryEntriesWithDefaults(listFn, cfg);
  const ids = entries.map((entry) => entry.id);
  expect(options?.sorted ? ids.toSorted() : ids).toEqual(expected);
}

describe("channel plugin loader", () => {
  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("loads channel plugins from the active registry", async () => {
    setActivePluginRegistry(registryWithMSTeams);
    const plugin = await loadChannelPlugin("msteams");
    expect(plugin).toBe(msteamsPlugin);
  });

  it("loads outbound adapters from registered plugins", async () => {
    setActivePluginRegistry(registryWithMSTeams);
    const outbound = await loadChannelOutboundAdapter("msteams");
    expect(outbound).toBe(msteamsOutbound);
  });

  it("refreshes cached plugin values when registry changes", async () => {
    setActivePluginRegistry(registryWithMSTeams);
    expect(await loadChannelPlugin("msteams")).toBe(msteamsPlugin);
    setActivePluginRegistry(registryWithMSTeamsV2);
    expect(await loadChannelPlugin("msteams")).toBe(msteamsPluginV2);
  });

  it("refreshes cached outbound values when registry changes", async () => {
    setActivePluginRegistry(registryWithMSTeams);
    expect(await loadChannelOutboundAdapter("msteams")).toBe(msteamsOutbound);
    setActivePluginRegistry(registryWithMSTeamsV2);
    expect(await loadChannelOutboundAdapter("msteams")).toBe(msteamsOutboundV2);
  });

  it("returns undefined when plugin has no outbound adapter", async () => {
    setActivePluginRegistry(registryWithMSTeamsNoOutbound);
    expect(await loadChannelOutboundAdapter("msteams")).toBeUndefined();
  });
});

describe("BaseProbeResult assignability", () => {
  it("TelegramProbe satisfies BaseProbeResult", () => {
    expectTypeOf<TelegramProbe>().toMatchTypeOf<BaseProbeResult>();
  });

  it("DiscordProbe satisfies BaseProbeResult", () => {
    expectTypeOf<DiscordProbe>().toMatchTypeOf<BaseProbeResult>();
  });

  it("SlackProbe satisfies BaseProbeResult", () => {
    expectTypeOf<SlackProbe>().toMatchTypeOf<BaseProbeResult>();
  });

  it("SignalProbe satisfies BaseProbeResult", () => {
    expectTypeOf<SignalProbe>().toMatchTypeOf<BaseProbeResult>();
  });

  it("IMessageProbe satisfies BaseProbeResult", () => {
    expectTypeOf<IMessageProbe>().toMatchTypeOf<BaseProbeResult>();
  });

  it("LineProbeResult satisfies BaseProbeResult", () => {
    expectTypeOf<LineProbeResult>().toMatchTypeOf<BaseProbeResult>();
  });
});

describe("BaseTokenResolution assignability", () => {
  it("Telegram and Discord token resolutions satisfy BaseTokenResolution", () => {
    expectTypeOf<TelegramTokenResolution>().toMatchTypeOf<BaseTokenResolution>();
    expectTypeOf<DiscordTokenResolution>().toMatchTypeOf<BaseTokenResolution>();
  });
});

describe("resolveChannelConfigWrites", () => {
  it("defaults to allow when unset", () => {
    const cfg = {};
    expect(resolveChannelConfigWrites({ cfg, channelId: "slack" })).toBe(true);
  });

  it("blocks when channel config disables writes", () => {
    const cfg = { channels: { slack: { configWrites: false } } };
    expect(resolveChannelConfigWrites({ cfg, channelId: "slack" })).toBe(false);
  });

  it("account override wins over channel default", () => {
    const cfg = makeSlackConfigWritesCfg("work");
    expect(resolveChannelConfigWrites({ cfg, channelId: "slack", accountId: "work" })).toBe(false);
  });

  it("matches account ids case-insensitively", () => {
    const cfg = makeSlackConfigWritesCfg("Work");
    expect(resolveChannelConfigWrites({ cfg, channelId: "slack", accountId: "work" })).toBe(false);
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
        cfg: makeSlackConfigWritesCfg(params.disabledAccountId),
        origin: { channelId: "slack", accountId: "default" },
        target: resolveExplicitConfigWriteTarget({ channelId: "slack", accountId: "work" }),
      }),
    ).toEqual({
      allowed: false,
      reason: params.reason,
      blockedScope: {
        kind: params.blockedScope,
        scope: {
          channelId: "slack",
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
    const cfg = makeSlackConfigWritesCfg("work");
    expect(
      authorizeConfigWrite({
        cfg,
        origin: { channelId: "slack", accountId: "default" },
        target: resolveExplicitConfigWriteTarget({ channelId: "slack", accountId: "work" }),
        allowBypass: canBypassConfigWritePolicy({
          channel: INTERNAL_MESSAGE_CHANNEL,
          gatewayClientScopes: ["operator.admin"],
        }),
      }),
    ).toEqual({ allowed: true });
  });

  it("treats non-channel config paths as global writes", () => {
    const cfg = makeSlackConfigWritesCfg("work");
    expect(
      authorizeConfigWrite({
        cfg,
        origin: { channelId: "slack", accountId: "default" },
        target: resolveConfigWriteTargetFromPath(["messages", "ackReaction"]),
      }),
    ).toEqual({ allowed: true });
  });

  it("rejects ambiguous channel collection writes", () => {
    expect(resolveConfigWriteTargetFromPath(["channels", "telegram"])).toEqual({
      kind: "ambiguous",
      scopes: [{ channelId: "telegram" }],
    });
    expect(resolveConfigWriteTargetFromPath(["channels", "telegram", "accounts"])).toEqual({
      kind: "ambiguous",
      scopes: [{ channelId: "telegram" }],
    });
  });

  it("resolves explicit channel and account targets", () => {
    expect(resolveExplicitConfigWriteTarget({ channelId: "slack" })).toEqual({
      kind: "channel",
      scope: { channelId: "slack" },
    });
    expect(resolveExplicitConfigWriteTarget({ channelId: "slack", accountId: "work" })).toEqual({
      kind: "account",
      scope: { channelId: "slack", accountId: "work" },
    });
  });

  it("formats denied messages consistently", () => {
    expect(
      formatConfigWriteDeniedMessage({
        result: {
          allowed: false,
          reason: "target-disabled",
          blockedScope: { kind: "target", scope: { channelId: "slack", accountId: "work" } },
        },
      }),
    ).toContain("channels.slack.accounts.work.configWrites=true");
  });
});

describe("directory (config-backed)", () => {
  it("lists Slack peers/groups from config", async () => {
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
          dm: { allowFrom: ["U123", "user:U999"] },
          dms: { U234: {} },
          channels: { C111: { users: ["U777"] } },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    await expectDirectoryIds(
      listSlackDirectoryPeersFromConfig,
      cfg,
      ["user:u123", "user:u234", "user:u777", "user:u999"],
      { sorted: true },
    );
    await expectDirectoryIds(listSlackDirectoryGroupsFromConfig, cfg, ["channel:c111"]);
  });

  it("lists Discord peers/groups from config (numeric ids only)", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "discord-test",
          dm: { allowFrom: ["<@111>", "<@!333>", "nope"] },
          dms: { "222": {} },
          guilds: {
            "123": {
              users: ["<@12345>", " discord:444 ", "not-an-id"],
              channels: {
                "555": {},
                "<#777>": {},
                "channel:666": {},
                general: {},
              },
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    await expectDirectoryIds(
      listDiscordDirectoryPeersFromConfig,
      cfg,
      ["user:111", "user:12345", "user:222", "user:333", "user:444"],
      { sorted: true },
    );
    await expectDirectoryIds(
      listDiscordDirectoryGroupsFromConfig,
      cfg,
      ["channel:555", "channel:666", "channel:777"],
      { sorted: true },
    );
  });

  it("lists Telegram peers/groups from config", async () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "telegram-test",
          allowFrom: ["123", "alice", "tg:@bob"],
          dms: { "456": {} },
          groups: { "-1001": {}, "*": {} },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    await expectDirectoryIds(
      listTelegramDirectoryPeersFromConfig,
      cfg,
      ["123", "456", "@alice", "@bob"],
      {
        sorted: true,
      },
    );
    await expectDirectoryIds(listTelegramDirectoryGroupsFromConfig, cfg, ["-1001"]);
  });

  it("keeps Telegram config-backed directory fallback semantics when accountId is omitted", async () => {
    await withEnvAsync({ TELEGRAM_BOT_TOKEN: "tok-env" }, async () => {
      const cfg = {
        channels: {
          telegram: {
            allowFrom: ["alice"],
            groups: { "-1001": {} },
            accounts: {
              work: {
                botToken: "tok-work",
                allowFrom: ["bob"],
                groups: { "-2002": {} },
              },
            },
          },
        },
        // oxlint-disable-next-line typescript/no-explicit-any
      } as any;

      await expectDirectoryIds(listTelegramDirectoryPeersFromConfig, cfg, ["@alice"]);
      await expectDirectoryIds(listTelegramDirectoryGroupsFromConfig, cfg, ["-1001"]);
    });
  });

  it("keeps config-backed directories readable when channel tokens are unresolved SecretRefs", async () => {
    const envSecret = {
      source: "env",
      provider: "default",
      id: "MISSING_TEST_SECRET",
    } as const;
    const cfg = {
      channels: {
        slack: {
          botToken: envSecret,
          appToken: envSecret,
          dm: { allowFrom: ["U123"] },
          channels: { C111: {} },
        },
        discord: {
          token: envSecret,
          dm: { allowFrom: ["<@111>"] },
          guilds: {
            "123": {
              channels: {
                "555": {},
              },
            },
          },
        },
        telegram: {
          botToken: envSecret,
          allowFrom: ["alice"],
          groups: { "-1001": {} },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    await expectDirectoryIds(listSlackDirectoryPeersFromConfig, cfg, ["user:u123"]);
    await expectDirectoryIds(listSlackDirectoryGroupsFromConfig, cfg, ["channel:c111"]);
    await expectDirectoryIds(listDiscordDirectoryPeersFromConfig, cfg, ["user:111"]);
    await expectDirectoryIds(listDiscordDirectoryGroupsFromConfig, cfg, ["channel:555"]);
    await expectDirectoryIds(listTelegramDirectoryPeersFromConfig, cfg, ["@alice"]);
    await expectDirectoryIds(listTelegramDirectoryGroupsFromConfig, cfg, ["-1001"]);
  });

  it("lists WhatsApp peers/groups from config", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          allowFrom: ["+15550000000", "*", "123@g.us"],
          groups: { "999@g.us": { requireMention: true }, "*": {} },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    await expectDirectoryIds(listWhatsAppDirectoryPeersFromConfig, cfg, ["+15550000000"]);
    await expectDirectoryIds(listWhatsAppDirectoryGroupsFromConfig, cfg, ["999@g.us"]);
  });

  it("applies query and limit filtering for config-backed directories", async () => {
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
          dm: { allowFrom: ["U100", "U200"] },
          dms: { U300: {} },
          channels: { C111: {}, C222: {}, C333: {} },
        },
        discord: {
          token: "discord-test",
          guilds: {
            "123": {
              channels: {
                "555": {},
                "666": {},
                "777": {},
              },
            },
          },
        },
        telegram: {
          botToken: "telegram-test",
          groups: { "-1001": {}, "-1002": {}, "-2001": {} },
        },
        whatsapp: {
          groups: { "111@g.us": {}, "222@g.us": {}, "333@s.whatsapp.net": {} },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    const slackPeers = await listSlackDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: "user:u",
      limit: 2,
    });
    expect(slackPeers).toHaveLength(2);
    expect(slackPeers.every((entry) => entry.id.startsWith("user:u"))).toBe(true);

    const discordGroups = await listDiscordDirectoryGroupsFromConfig({
      cfg,
      accountId: "default",
      query: "666",
      limit: 5,
    });
    expect(discordGroups.map((entry) => entry.id)).toEqual(["channel:666"]);

    const telegramGroups = await listTelegramDirectoryGroupsFromConfig({
      cfg,
      accountId: "default",
      query: "-100",
      limit: 1,
    });
    expect(telegramGroups.map((entry) => entry.id)).toEqual(["-1001"]);

    const whatsAppGroups = await listWhatsAppDirectoryGroupsFromConfig({
      cfg,
      accountId: "default",
      query: "@g.us",
      limit: 1,
    });
    expect(whatsAppGroups.map((entry) => entry.id)).toEqual(["111@g.us"]);
  });
});
