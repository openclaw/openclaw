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
  scanConfiguredChannelPluginBlockers as scan,
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
    packageChannel: { id: options.channelId ?? id, configuredState: { env: { anyOf: [token] } } },
  });
}
const sharedOwner = (id: string, options: Parameters<typeof plugin>[1] = {}) =>
  plugin(id, { origin: "config", channelId: "shared-chat", ...options });
const bundledOwner = { origin: "bundled", enabledByDefault: true } as const;
type Blocker = ReturnType<typeof scan>[number];
function hit(channelId: string, reason: Blocker["reason"], pluginId = channelId): Blocker {
  return { channelId, pluginId, reason };
}
function mockManifestPlugins(plugins: manifestRegistry.PluginManifestRecord[]) {
  vi.spyOn(manifestRegistry, "loadPluginManifestRegistryCore").mockReturnValue({
    plugins,
    diagnostics: [],
  });
}
const discordChannels = { discord: { enabled: true, token: "configured" } };
const legacyChannels = { "legacy-chat": { token: "configured" } };
const disabledDiscord = { discord: { enabled: false } };
const workspaceSource: OpenClawConfig = {
  channels: { "workspace-chat": { enabled: true } },
  plugins: { allow: ["browser"], entries: { "workspace-chat": { enabled: true } } },
};
const irc = () =>
  plugin("irc", {
    packageChannel: { id: "irc", configuredState: { env: { allOf: ["IRC_HOST", "IRC_NICK"] } } },
  });
type ScanCase = [
  name: string,
  plugins: manifestRegistry.PluginManifestRecord[],
  cfg: OpenClawConfig,
  expected: Blocker[],
  env?: NodeJS.ProcessEnv,
  source?: OpenClawConfig,
  options?: Parameters<typeof scan>[3],
];

describe("channel plugin blockers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearPluginMetadataLifecycleCaches();
  });

  it("reports external channel plugins that are installed but not explicitly enabled", () => {
    mockManifestPlugins([plugin("discord")]);
    const hits = scan({ channels: discordChannels });
    const message =
      'channels.discord: channel is configured, but external plugin "discord" is installed without explicit trust. Add plugins.entries.discord.enabled=true. Fix plugin enablement before relying on setup guidance for this channel.';
    expect(hits).toEqual([hit("discord", "missing explicit enablement")]);
    expect(collectConfiguredChannelPluginBlockerWarnings(hits)).toEqual([`- ${message}`]);
    expect(channelPluginBlockerHitToHealthFinding(expectDefined(hits[0], "blocker"))).toEqual({
      checkId: "core/doctor/channel-plugin-blockers",
      severity: "warning",
      message,
      path: "channels.discord",
      target: "discord",
      requirement: "missing explicit enablement",
      fixHint: "Fix plugin enablement before relying on setup guidance for this channel.",
    });
  });

  it.each<ScanCase>([
    [
      "explicit allowlist trust",
      [plugin("discord")],
      { plugins: { allow: ["discord"] }, channels: discordChannels },
      [],
    ],
    [
      "effective preferOver fallback disablement",
      [
        plugin("legacy-chat", bundledOwner),
        plugin("modern-chat", {
          origin: "config",
          channelId: "legacy-chat",
          channelConfigs: {
            "legacy-chat": { schema: { type: "object" }, preferOver: ["legacy-chat"] },
          },
        }),
      ],
      {
        channels: legacyChannels,
        plugins: {
          entries: { "legacy-chat": { enabled: false }, "modern-chat": { enabled: true } },
        },
      },
      [hit("legacy-chat", "missing explicit enablement", "modern-chat")],
      process.env,
      { channels: legacyChannels },
    ],
    [
      "suppressed startup environment",
      [packagePlugin("discord", "DISCORD_FAKE_TEST_TRIGGER")],
      {},
      [],
      { DISCORD_FAKE_TEST_TRIGGER: "configured" },
      {},
      { ambientEnvTriggers: "suppress" },
    ],
    ["incomplete allOf environment", [irc()], {}, [], { IRC_HOST: "configured" }],
    [
      "complete allOf environment",
      [irc()],
      {},
      [hit("irc", "missing explicit enablement")],
      { IRC_HOST: "configured", IRC_NICK: "configured" },
    ],
    [
      "package environment scoped to declaring owner",
      [
        sharedOwner("bundled-chat", bundledOwner),
        packagePlugin("external-chat", "EXTERNAL_CHAT_TOKEN", {
          origin: "config",
          channelId: "shared-chat",
        }),
      ],
      { plugins: { entries: { "external-chat": { enabled: true } } } },
      [
        {
          ...hit("shared-chat", "missing explicit enablement", "external-chat"),
          channelAvailable: true,
        },
      ],
      { EXTERNAL_CHAT_TOKEN: "configured" },
      {},
    ],
    [
      "available co-owner for the same environment trigger",
      [
        packagePlugin("bundled-chat", "SHARED_CHAT_TOKEN", {
          channelId: "shared-chat",
          ...bundledOwner,
        }),
        packagePlugin("external-chat", "SHARED_CHAT_TOKEN", {
          channelId: "shared-chat",
          origin: "config",
        }),
      ],
      {},
      [],
      { SHARED_CHAT_TOKEN: "configured" },
    ],
    [
      "deduplicated global disablement",
      ["first", "second"].map((name) =>
        packagePlugin(`${name}-chat`, `${name.toUpperCase()}_CHAT_TOKEN`, {
          origin: "config",
          channelId: "shared-chat",
        }),
      ),
      { plugins: { enabled: false } },
      [hit("shared-chat", "plugins disabled", "first-chat")],
      { FIRST_CHAT_TOKEN: "configured", SECOND_CHAT_TOKEN: "configured" },
    ],
    [
      "explicit channel disablement",
      [packagePlugin("discord", "DISCORD_BOT_TOKEN")],
      { channels: disabledDiscord, plugins: { entries: { discord: { enabled: true } } } },
      [],
      { DISCORD_BOT_TOKEN: "configured" },
      { channels: disabledDiscord },
    ],
    [
      "workspace trust across an auto-materialized allowlist",
      [plugin("workspace-chat", { origin: "workspace" })],
      {
        ...workspaceSource,
        plugins: { ...workspaceSource.plugins, allow: ["browser", "workspace-chat"] },
      },
      [],
      process.env,
      workspaceSource,
    ],
    [
      "workspace slot activation",
      [plugin("workspace-chat", { origin: "workspace" })],
      {
        plugins: { allow: ["browser"], slots: { contextEngine: "workspace-chat" } },
        channels: { "workspace-chat": { token: "configured" } },
      },
      [],
    ],
  ])("handles %s", (_name, plugins, cfg, expected, env, source, options) => {
    mockManifestPlugins(plugins);
    const hits = scan(cfg, env, source, options);
    if (expected.length === 0) {
      expect(hits).toStrictEqual([]);
    } else {
      expect(hits).toEqual(expected);
    }
  });

  it.each([
    [true, false],
    [false, true],
  ])(
    "preserves channel-wide warnings when a co-owner is available (available=%s)",
    (available, blocked) => {
      const blocker = hit("shared-chat", "missing explicit enablement", "external-chat");
      expect(
        isWarningBlockedByChannelPlugin("channels.shared-chat.groupPolicy: warning", [
          available ? { ...blocker, channelAvailable: true } : blocker,
        ]),
      ).toBe(blocked);
    },
  );

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
    const hits = scan(plugins ? { plugins } : {}, { OPENCLAW_TWITCH_ACCESS_TOKEN: "configured" });
    expect(hits).toEqual([hit("twitch", reason)]);
    expect(collectConfiguredChannelPluginBlockerWarnings(hits)).toEqual([warning]);
  });

  it("reports external channel plugins omitted from a restrictive allowlist", () => {
    mockManifestPlugins([plugin("discord")]);
    const hits = scan({ plugins: { allow: ["brave"] }, channels: discordChannels });
    expect(hits).toEqual([hit("discord", "not in allowlist")]);
    expect(collectConfiguredChannelPluginBlockerWarnings(hits)).toEqual([
      '- channels.discord: channel is configured, but plugin "discord" is installed but omitted from plugins.allow. Include "discord" in plugins.allow. Fix plugin enablement before relying on setup guidance for this channel.',
    ]);
  });

  it("keeps blocker reasons scoped to each external owner", () => {
    mockManifestPlugins([sharedOwner("denied-chat"), sharedOwner("untrusted-chat")]);
    const hits = scan({
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
});
