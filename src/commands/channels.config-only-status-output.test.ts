import { describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import { makeDirectPlugin } from "../test-utils/channel-plugin-test-fixtures.js";
import { formatConfigChannelsStatusLines } from "./channels/status-config-format.js";

const activeChannelPlugins = vi.hoisted(() => [] as ChannelPlugin[]);
const listReadOnlyChannelPluginsForConfig = vi.hoisted(() => vi.fn(() => activeChannelPlugins));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () => activeChannelPlugins,
  getLoadedChannelPlugin: (id: string) => activeChannelPlugins.find((plugin) => plugin.id === id),
  getChannelPlugin: (id: string) => activeChannelPlugins.find((plugin) => plugin.id === id),
  normalizeChannelId: (value: string) => {
    const normalized = value.trim().toLowerCase();
    return normalized === "wa" || normalized === "whatsapp" ? "whatsapp" : null;
  },
}));

vi.mock("../channels/plugins/read-only.js", () => ({ listReadOnlyChannelPluginsForConfig }));

function registerSingleTestPlugin(plugin: ChannelPlugin) {
  activeChannelPlugins.splice(0, activeChannelPlugins.length, plugin);
}

async function formatLocalStatusSummary(
  cfg: OpenClawConfig & { secretResolved?: boolean },
  options?: Parameters<typeof formatConfigChannelsStatusLines>[2],
) {
  const lines = await formatConfigChannelsStatusLines(cfg, { mode: "local" }, options);
  return lines.join("\n");
}

function unresolvedTokenAccount() {
  return {
    name: "Primary",
    enabled: true,
    configured: true,
    token: "",
    tokenSource: "config",
    tokenStatus: "configured_unavailable",
  } as const;
}

function makeTokenPlugin(config: Partial<ChannelPlugin["config"]> = {}): ChannelPlugin {
  return makeDirectPlugin({
    id: "token-only",
    label: "TokenOnly",
    docsPath: "/channels/token-only",
    config: {
      listAccountIds: () => ["primary"],
      defaultAccountId: () => "primary",
      isConfigured: () => true,
      isEnabled: () => true,
      resolveAccount: () => unresolvedTokenAccount(),
      ...config,
    },
  });
}

function makeResolvedTokenPlugin(): ChannelPlugin {
  return makeTokenPlugin({
    inspectAccount: (cfg) =>
      (cfg as { secretResolved?: boolean }).secretResolved
        ? { accountId: "primary", ...availableTokenAccount() }
        : { accountId: "primary", ...unresolvedTokenAccount() },
  });
}

function makeResolvedTokenPluginWithoutInspectAccount(): ChannelPlugin {
  return makeTokenPlugin({
    resolveAccount: (cfg) => {
      if (!(cfg as { secretResolved?: boolean }).secretResolved) {
        throw new Error("raw SecretRef reached resolveAccount");
      }
      return availableTokenAccount();
    },
  });
}

function availableTokenAccount() {
  return { ...unresolvedTokenAccount(), token: "resolved-token", tokenStatus: "available" };
}

function makeIndeterminateLinkPlugin(): ChannelPlugin {
  return makeDirectPlugin({
    id: "whatsapp",
    label: "WhatsApp",
    docsPath: "/channels/whatsapp",
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({ accountId: "default", enabled: true, authDir: "/auth" }),
      isEnabled: () => true,
      isConfigured: () => true,
      isLinked: () => "unknown",
      unlinkedReason: () => "not linked",
      describeAccount: () => ({
        accountId: "default",
        enabled: true,
        configured: true,
      }),
    },
  });
}

function expectResolvedTokenStatusSummary(summary: string, checkUnavailable: boolean) {
  expect(summary).toContain("TokenOnly");
  expect(summary).toContain("configured");
  expect(summary).toContain("token:config");
  expect(summary).not.toContain("secret unavailable in this command path");
  if (checkUnavailable) {
    expect(summary).not.toContain("token:config (unavailable)");
  }
}

describe("config-only channels status output", () => {
  it("preserves exact config-only status filtering for external channels", async () => {
    activeChannelPlugins.splice(
      0,
      activeChannelPlugins.length,
      makeTokenPlugin(),
      makeIndeterminateLinkPlugin(),
    );

    const summary = await formatLocalStatusSummary(
      { channels: { "token-only": {}, whatsapp: {} } },
      { channel: "TOKEN-ONLY" },
    );

    expect(summary).toContain("Gateway not reachable; showing config-only status.");
    expect(summary).toContain("TokenOnly");
    expect(summary).not.toContain("WhatsApp");
  });

  it.each([
    {
      name: "does not resolve raw source config without inspectAccount",
      makePlugin: makeResolvedTokenPluginWithoutInspectAccount,
      checkUnavailable: false,
    },
    {
      name: "prefers resolved snapshots after secret resolution",
      makePlugin: makeResolvedTokenPlugin,
      checkUnavailable: true,
    },
  ])("$name", async ({ makePlugin, checkUnavailable }) => {
    registerSingleTestPlugin(makePlugin());
    const joined = await formatLocalStatusSummary(
      { secretResolved: true, channels: {} },
      { sourceConfig: { channels: {} } },
    );
    expectResolvedTokenStatusSummary(joined, checkUnavailable);
  });
});
