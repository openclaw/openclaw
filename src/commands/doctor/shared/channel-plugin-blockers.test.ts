import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import * as manifestRegistry from "../../../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../../../plugins/plugin-metadata-lifecycle.js";
import { createPluginManifestRecordFixture } from "../../../plugins/plugin-metadata.test-support.js";
import {
  channelPluginBlockerHitToHealthFinding,
  collectConfiguredChannelPluginBlockerWarnings,
  isWarningBlockedByChannelPlugin,
  scanConfiguredChannelPluginBlockers,
} from "./channel-plugin-blockers.js";

function plugin(
  id: string,
  options: Partial<manifestRegistry.PluginManifestRecord> & { channelId?: string } = {},
) {
  const { channelId = id, ...metadata } = options;
  const rootDir = `/plugins/${id}`;
  return createPluginManifestRecordFixture({
    id,
    origin: "global",
    channels: [channelId],
    enabledByDefault: false,
    rootDir,
    source: `${rootDir}/index.ts`,
    ...metadata,
  });
}

function packagePlugin(id: string, token: string, options: Parameters<typeof plugin>[1] = {}) {
  return plugin(id, {
    ...options,
    packageChannel: {
      id: options.channelId ?? id,
      configuredState: { env: { anyOf: [token] } },
    },
  });
}

const sharedOwner = (id: string, options: Parameters<typeof plugin>[1] = {}) =>
  plugin(id, { origin: "config", channelId: "shared-chat", ...options });
const bundledOwner = { origin: "bundled", enabledByDefault: true } as const;

function mockManifestPlugins(plugins: manifestRegistry.PluginManifestRecord[]) {
  vi.spyOn(manifestRegistry, "loadPluginManifestRegistryCore").mockReturnValue({
    plugins,
    diagnostics: [],
  });
}

type Blocker = ReturnType<typeof scanConfiguredChannelPluginBlockers>[number];
function hit(channelId: string, reason: Blocker["reason"], pluginId = channelId): Blocker {
  return { channelId, pluginId, reason };
}

const discordChannels = { discord: { enabled: true, token: "configured" } };

describe("channel plugin blockers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearPluginMetadataLifecycleCaches();
  });

  it("reports external channel plugins that are installed but not explicitly enabled", () => {
    mockManifestPlugins([plugin("discord")]);

    const hits = scanConfiguredChannelPluginBlockers({ channels: discordChannels });

    expect(hits).toEqual([hit("discord", "missing explicit enablement")]);
    expect(collectConfiguredChannelPluginBlockerWarnings(hits)).toEqual([
      '- channels.discord: channel is configured, but external plugin "discord" is installed without explicit trust. Add plugins.entries.discord.enabled=true. Fix plugin enablement before relying on setup guidance for this channel.',
    ]);
    expect(
      channelPluginBlockerHitToHealthFinding(expectDefined(hits[0], "hits[0] test invariant")),
    ).toEqual({
      checkId: "core/doctor/channel-plugin-blockers",
      severity: "warning",
      message:
        'channels.discord: channel is configured, but external plugin "discord" is installed without explicit trust. Add plugins.entries.discord.enabled=true. Fix plugin enablement before relying on setup guidance for this channel.',
      path: "channels.discord",
      target: "discord",
      requirement: "missing explicit enablement",
      fixHint: "Fix plugin enablement before relying on setup guidance for this channel.",
    });
  });

  it("accepts plugins.allow as explicit trust for external channel plugins", () => {
    mockManifestPlugins([plugin("discord")]);

    const hits = scanConfiguredChannelPluginBlockers({
      plugins: { allow: ["discord"] },
      channels: discordChannels,
    });

    expect(hits).toStrictEqual([]);
  });

  it("uses effective config for preferOver fallback disablement", () => {
    mockManifestPlugins([
      plugin("legacy-chat", { origin: "bundled", enabledByDefault: true }),
      plugin("modern-chat", {
        origin: "config",
        channelId: "legacy-chat",
        channelConfigs: {
          "legacy-chat": { schema: { type: "object" }, preferOver: ["legacy-chat"] },
        },
      }),
    ]);

    const channels = { "legacy-chat": { token: "configured" } };
    const hits = scanConfiguredChannelPluginBlockers(
      {
        channels,
        plugins: {
          entries: { "legacy-chat": { enabled: false }, "modern-chat": { enabled: true } },
        },
      },
      process.env,
      { channels },
    );

    expect(hits).toEqual([hit("legacy-chat", "missing explicit enablement", "modern-chat")]);
  });

  it("suppresses ambient-only package env blockers for gateway startup", () => {
    mockManifestPlugins([packagePlugin("discord", "DISCORD_FAKE_TEST_TRIGGER")]);

    expect(
      scanConfiguredChannelPluginBlockers(
        {},
        { DISCORD_FAKE_TEST_TRIGGER: "configured" },
        {},
        { ambientEnvTriggers: "suppress" },
      ),
    ).toStrictEqual([]);
  });

  it("requires every package channel allOf environment variable", () => {
    mockManifestPlugins([
      plugin("irc", {
        packageChannel: {
          id: "irc",
          configuredState: { env: { allOf: ["IRC_HOST", "IRC_NICK"] } },
        },
      }),
    ]);

    expect(scanConfiguredChannelPluginBlockers({}, { IRC_HOST: "configured" })).toStrictEqual([]);
    expect(
      scanConfiguredChannelPluginBlockers({}, { IRC_HOST: "configured", IRC_NICK: "configured" }),
    ).toEqual([hit("irc", "missing explicit enablement")]);
  });

  it("keeps package env trust diagnostics scoped to the declaring owner", () => {
    mockManifestPlugins([
      sharedOwner("bundled-chat", bundledOwner),
      packagePlugin("external-chat", "EXTERNAL_CHAT_TOKEN", {
        origin: "config",
        channelId: "shared-chat",
      }),
    ]);

    const hits = scanConfiguredChannelPluginBlockers(
      { plugins: { entries: { "external-chat": { enabled: true } } } },
      { EXTERNAL_CHAT_TOKEN: "configured" },
      {},
    );

    expect(hits).toEqual([
      {
        ...hit("shared-chat", "missing explicit enablement", "external-chat"),
        channelAvailable: true,
      },
    ]);
  });

  it("preserves channel-wide warnings when only a co-owner is blocked", () => {
    expect(
      isWarningBlockedByChannelPlugin("channels.shared-chat.groupPolicy: warning", [
        {
          ...hit("shared-chat", "missing explicit enablement", "external-chat"),
          channelAvailable: true,
        },
      ]),
    ).toBe(false);
    expect(
      isWarningBlockedByChannelPlugin("channels.shared-chat.groupPolicy: warning", [
        hit("shared-chat", "missing explicit enablement", "external-chat"),
      ]),
    ).toBe(true);
  });

  it("accepts an available co-owner for the same package env trigger", () => {
    mockManifestPlugins(
      ["bundled-chat", "external-chat"].map((id, index) =>
        packagePlugin(id, "SHARED_CHAT_TOKEN", {
          channelId: "shared-chat",
          ...(index === 0 ? bundledOwner : { origin: "config" as const }),
        }),
      ),
    );

    const hits = scanConfiguredChannelPluginBlockers({}, { SHARED_CHAT_TOKEN: "configured" });

    expect(hits).toStrictEqual([]);
  });

  it("deduplicates global plugin disablement across package env triggers", () => {
    mockManifestPlugins(
      ["first", "second"].map((name) =>
        packagePlugin(`${name}-chat`, `${name.toUpperCase()}_CHAT_TOKEN`, {
          origin: "config",
          channelId: "shared-chat",
        }),
      ),
    );

    const hits = scanConfiguredChannelPluginBlockers(
      { plugins: { enabled: false } },
      { FIRST_CHAT_TOKEN: "configured", SECOND_CHAT_TOKEN: "configured" },
    );

    expect(hits).toEqual([hit("shared-chat", "plugins disabled", "first-chat")]);
  });

  it.each([
    {
      plugins: undefined,
      reason: "not enabled" as const,
      warning:
        '- channels.twitch: channel is configured, but plugin "twitch" is installed but not enabled. Add plugins.entries.twitch.enabled=true. Fix plugin enablement before relying on setup guidance for this channel.',
    },
    {
      plugins: { allow: ["browser"] },
      reason: "not enabled and not in allowlist" as const,
      warning:
        '- channels.twitch: channel is configured, but plugin "twitch" is not enabled and is omitted from plugins.allow. Add plugins.entries.twitch.enabled=true and include "twitch" in plugins.allow. Fix plugin enablement before relying on setup guidance for this channel.',
    },
  ])("diagnoses bundled opt-in owner: $reason", ({ plugins, reason, warning }) => {
    mockManifestPlugins([
      packagePlugin("twitch", "OPENCLAW_TWITCH_ACCESS_TOKEN", { origin: "bundled" }),
    ]);
    const hits = scanConfiguredChannelPluginBlockers(plugins ? { plugins } : {}, {
      OPENCLAW_TWITCH_ACCESS_TOKEN: "configured",
    });
    expect(hits).toEqual([hit("twitch", reason)]);
    expect(collectConfiguredChannelPluginBlockerWarnings(hits)).toEqual([warning]);
  });

  it("honors explicit channel disablement over package env triggers", () => {
    mockManifestPlugins([packagePlugin("discord", "DISCORD_BOT_TOKEN")]);

    const channels = { discord: { enabled: false } };
    const hits = scanConfiguredChannelPluginBlockers(
      { channels, plugins: { entries: { discord: { enabled: true } } } },
      { DISCORD_BOT_TOKEN: "configured" },
      { channels },
    );

    expect(hits).toStrictEqual([]);
  });

  it("preserves explicit workspace trust across an auto-materialized allowlist", () => {
    mockManifestPlugins([plugin("workspace-chat", { origin: "workspace" })]);

    const sourceConfig: OpenClawConfig = {
      channels: { "workspace-chat": { enabled: true } },
      plugins: { allow: ["browser"], entries: { "workspace-chat": { enabled: true } } },
    };
    const hits = scanConfiguredChannelPluginBlockers(
      {
        ...sourceConfig,
        plugins: { ...sourceConfig.plugins, allow: ["browser", "workspace-chat"] },
      },
      process.env,
      sourceConfig,
    );

    expect(hits).toStrictEqual([]);
  });

  it("reports external channel plugins omitted from a restrictive allowlist", () => {
    mockManifestPlugins([plugin("discord")]);

    const hits = scanConfiguredChannelPluginBlockers({
      plugins: { allow: ["brave"] },
      channels: discordChannels,
    });

    expect(hits).toEqual([hit("discord", "not in allowlist")]);
    expect(collectConfiguredChannelPluginBlockerWarnings(hits)).toEqual([
      '- channels.discord: channel is configured, but plugin "discord" is installed but omitted from plugins.allow. Include "discord" in plugins.allow. Fix plugin enablement before relying on setup guidance for this channel.',
    ]);
  });

  it("keeps blocker reasons scoped to each external owner", () => {
    mockManifestPlugins([sharedOwner("denied-chat"), sharedOwner("untrusted-chat")]);

    const hits = scanConfiguredChannelPluginBlockers({
      plugins: { deny: ["denied-chat"] },
      channels: { "shared-chat": { token: "configured" } },
    });

    expect(hits).toEqual([
      hit("shared-chat", "blocked by denylist", "denied-chat"),
      hit("shared-chat", "missing explicit enablement", "untrusted-chat"),
    ]);
    expect(collectConfiguredChannelPluginBlockerWarnings(hits)).toEqual([
      '- channels.shared-chat: channel is configured, but plugin "denied-chat" is blocked by plugins.deny. Remove "denied-chat" from plugins.deny. Fix plugin enablement before relying on setup guidance for this channel.',
      '- channels.shared-chat: channel is configured, but external plugin "untrusted-chat" is installed without explicit trust. Add plugins.entries.untrusted-chat.enabled=true. Fix plugin enablement before relying on setup guidance for this channel.',
    ]);
  });

  it("accepts workspace channel owners activated through a plugin slot", () => {
    mockManifestPlugins([plugin("workspace-chat", { origin: "workspace" })]);

    const hits = scanConfiguredChannelPluginBlockers({
      plugins: { allow: ["browser"], slots: { contextEngine: "workspace-chat" } },
      channels: { "workspace-chat": { token: "configured" } },
    });

    expect(hits).toStrictEqual([]);
  });
});
