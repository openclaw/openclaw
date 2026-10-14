// Channel plugin blocker tests cover doctor diagnostics for blocked channel plugin setup.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import * as manifestRegistry from "../../../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../../../plugins/plugin-metadata-lifecycle.js";
import {
  channelPluginBlockerHitToHealthFinding,
  collectConfiguredChannelPluginBlockerWarnings,
  isWarningBlockedByChannelPlugin,
  scanConfiguredChannelPluginBlockers,
} from "./channel-plugin-blockers.js";

function createPackageChannelEnv(channelId: string, envVars: string[]) {
  return {
    id: channelId,
    configuredState: { env: { anyOf: envVars } },
  };
}

function plugin(
  id: string,
  options: {
    origin?: "bundled" | "config" | "global" | "workspace";
    channelId?: string;
    enabledByDefault?: boolean;
    [key: string]: unknown;
  } = {},
) {
  const { origin = "global", channelId = id, enabledByDefault = false, ...metadata } = options;
  const rootDir = `/plugins/${id}`;
  return {
    id,
    origin,
    channels: [channelId],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    enabledByDefault,
    rootDir,
    source: `${rootDir}/index.ts`,
    manifestPath: `${rootDir}/openclaw.plugin.json`,
    ...metadata,
  };
}

function mockManifestPlugins(plugins: unknown[]) {
  vi.spyOn(manifestRegistry, "loadPluginManifestRegistryCore").mockReturnValue({
    plugins,
    diagnostics: [],
  } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistryCore>);
}

describe("channel plugin blockers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearPluginMetadataLifecycleCaches();
  });

  it("reports external channel plugins that are installed but not explicitly enabled", () => {
    mockManifestPlugins([plugin("discord")]);

    const hits = scanConfiguredChannelPluginBlockers({
      channels: {
        discord: {
          enabled: true,
          token: "configured",
        },
      },
    });

    expect(hits).toEqual([
      {
        channelId: "discord",
        pluginId: "discord",
        reason: "missing explicit enablement",
      },
    ]);
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
      plugins: {
        allow: ["discord"],
      },
      channels: {
        discord: {
          enabled: true,
          token: "configured",
        },
      },
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
          "legacy-chat": {
            schema: { type: "object" },
            preferOver: ["legacy-chat"],
          },
        },
      }),
    ]);

    const channels = {
      "legacy-chat": {
        token: "configured",
      },
    };
    const hits = scanConfiguredChannelPluginBlockers(
      {
        channels,
        plugins: {
          entries: {
            "legacy-chat": { enabled: false },
            "modern-chat": { enabled: true },
          },
        },
      },
      process.env,
      { channels },
    );

    expect(hits).toEqual([
      {
        channelId: "legacy-chat",
        pluginId: "modern-chat",
        reason: "missing explicit enablement",
      },
    ]);
  });

  it("suppresses ambient-only package env blockers for gateway startup", () => {
    mockManifestPlugins([
      plugin("discord", {
        packageChannel: createPackageChannelEnv("discord", ["DISCORD_FAKE_TEST_TRIGGER"]),
      }),
    ]);

    expect(
      scanConfiguredChannelPluginBlockers(
        {},
        { DISCORD_FAKE_TEST_TRIGGER: "configured" } as NodeJS.ProcessEnv,
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

    expect(
      scanConfiguredChannelPluginBlockers({}, { IRC_HOST: "configured" } as NodeJS.ProcessEnv),
    ).toStrictEqual([]);
    expect(
      scanConfiguredChannelPluginBlockers({}, {
        IRC_HOST: "configured",
        IRC_NICK: "configured",
      } as NodeJS.ProcessEnv),
    ).toEqual([
      {
        channelId: "irc",
        pluginId: "irc",
        reason: "missing explicit enablement",
      },
    ]);
  });

  it("keeps package env trust diagnostics scoped to the declaring owner", () => {
    mockManifestPlugins([
      plugin("bundled-chat", {
        origin: "bundled",
        channelId: "shared-chat",
        enabledByDefault: true,
      }),
      plugin("external-chat", {
        origin: "config",
        channelId: "shared-chat",
        packageChannel: createPackageChannelEnv("shared-chat", ["EXTERNAL_CHAT_TOKEN"]),
      }),
    ]);

    const hits = scanConfiguredChannelPluginBlockers(
      {
        plugins: {
          entries: {
            "external-chat": { enabled: true },
          },
        },
      },
      {
        EXTERNAL_CHAT_TOKEN: "configured",
      } as NodeJS.ProcessEnv,
      {},
    );

    expect(hits).toEqual([
      {
        channelId: "shared-chat",
        pluginId: "external-chat",
        reason: "missing explicit enablement",
        channelAvailable: true,
      },
    ]);
  });

  it("preserves channel-wide warnings when only a co-owner is blocked", () => {
    expect(
      isWarningBlockedByChannelPlugin("channels.shared-chat.groupPolicy: warning", [
        {
          channelId: "shared-chat",
          pluginId: "external-chat",
          reason: "missing explicit enablement",
          channelAvailable: true,
        },
      ]),
    ).toBe(false);
    expect(
      isWarningBlockedByChannelPlugin("channels.shared-chat.groupPolicy: warning", [
        {
          channelId: "shared-chat",
          pluginId: "external-chat",
          reason: "missing explicit enablement",
        },
      ]),
    ).toBe(true);
  });

  it("accepts an available co-owner for the same package env trigger", () => {
    mockManifestPlugins([
      plugin("bundled-chat", {
        origin: "bundled",
        channelId: "shared-chat",
        packageChannel: createPackageChannelEnv("shared-chat", ["SHARED_CHAT_TOKEN"]),
        enabledByDefault: true,
      }),
      plugin("external-chat", {
        origin: "config",
        channelId: "shared-chat",
        packageChannel: createPackageChannelEnv("shared-chat", ["SHARED_CHAT_TOKEN"]),
      }),
    ]);

    const hits = scanConfiguredChannelPluginBlockers({}, {
      SHARED_CHAT_TOKEN: "configured",
    } as NodeJS.ProcessEnv);

    expect(hits).toStrictEqual([]);
  });

  it("deduplicates global plugin disablement across package env triggers", () => {
    mockManifestPlugins([
      plugin("first-chat", {
        origin: "config",
        channelId: "shared-chat",
        packageChannel: createPackageChannelEnv("shared-chat", ["FIRST_CHAT_TOKEN"]),
      }),
      plugin("second-chat", {
        origin: "config",
        channelId: "shared-chat",
        packageChannel: createPackageChannelEnv("shared-chat", ["SECOND_CHAT_TOKEN"]),
      }),
    ]);

    const hits = scanConfiguredChannelPluginBlockers(
      {
        plugins: {
          enabled: false,
        },
      },
      {
        FIRST_CHAT_TOKEN: "configured",
        SECOND_CHAT_TOKEN: "configured",
      } as NodeJS.ProcessEnv,
    );

    expect(hits).toEqual([
      {
        channelId: "shared-chat",
        pluginId: "first-chat",
        reason: "plugins disabled",
      },
    ]);
  });

  it("diagnoses a package env channel whose bundled owner is opt-in", () => {
    mockManifestPlugins([
      plugin("twitch", {
        origin: "bundled",
        packageChannel: createPackageChannelEnv("twitch", ["OPENCLAW_TWITCH_ACCESS_TOKEN"]),
      }),
    ]);

    const hits = scanConfiguredChannelPluginBlockers({}, {
      OPENCLAW_TWITCH_ACCESS_TOKEN: "configured",
    } as NodeJS.ProcessEnv);

    expect(hits).toEqual([
      {
        channelId: "twitch",
        pluginId: "twitch",
        reason: "not enabled",
      },
    ]);
    expect(collectConfiguredChannelPluginBlockerWarnings(hits)).toEqual([
      '- channels.twitch: channel is configured, but plugin "twitch" is installed but not enabled. Add plugins.entries.twitch.enabled=true. Fix plugin enablement before relying on setup guidance for this channel.',
    ]);
  });

  it("includes both actions for a bundled opt-in owner under a restrictive allowlist", () => {
    mockManifestPlugins([
      plugin("twitch", {
        origin: "bundled",
        packageChannel: createPackageChannelEnv("twitch", ["OPENCLAW_TWITCH_ACCESS_TOKEN"]),
      }),
    ]);

    const hits = scanConfiguredChannelPluginBlockers(
      {
        plugins: {
          allow: ["browser"],
        },
      },
      {
        OPENCLAW_TWITCH_ACCESS_TOKEN: "configured",
      } as NodeJS.ProcessEnv,
    );

    expect(hits).toEqual([
      {
        channelId: "twitch",
        pluginId: "twitch",
        reason: "not enabled and not in allowlist",
      },
    ]);
    expect(collectConfiguredChannelPluginBlockerWarnings(hits)).toEqual([
      '- channels.twitch: channel is configured, but plugin "twitch" is not enabled and is omitted from plugins.allow. Add plugins.entries.twitch.enabled=true and include "twitch" in plugins.allow. Fix plugin enablement before relying on setup guidance for this channel.',
    ]);
  });

  it("honors explicit channel disablement over package env triggers", () => {
    mockManifestPlugins([
      plugin("discord", {
        packageChannel: createPackageChannelEnv("discord", ["DISCORD_BOT_TOKEN"]),
      }),
    ]);

    const hits = scanConfiguredChannelPluginBlockers(
      {
        channels: {
          discord: {
            enabled: false,
          },
        },
        plugins: {
          entries: {
            discord: { enabled: true },
          },
        },
      },
      {
        DISCORD_BOT_TOKEN: "configured",
      } as NodeJS.ProcessEnv,
      {
        channels: {
          discord: {
            enabled: false,
          },
        },
      },
    );

    expect(hits).toStrictEqual([]);
  });

  it("preserves explicit workspace trust across an auto-materialized allowlist", () => {
    mockManifestPlugins([
      plugin("workspace-chat", { origin: "workspace", channelId: "workspace-chat" }),
    ]);

    const sourceConfig: OpenClawConfig = {
      channels: {
        "workspace-chat": {
          enabled: true,
        },
      },
      plugins: {
        allow: ["browser"],
        entries: {
          "workspace-chat": { enabled: true },
        },
      },
    };
    const hits = scanConfiguredChannelPluginBlockers(
      {
        ...sourceConfig,
        plugins: {
          ...sourceConfig.plugins,
          allow: ["browser", "workspace-chat"],
        },
      },
      process.env,
      sourceConfig,
    );

    expect(hits).toStrictEqual([]);
  });

  it("reports external channel plugins omitted from a restrictive allowlist", () => {
    mockManifestPlugins([plugin("discord")]);

    const hits = scanConfiguredChannelPluginBlockers({
      plugins: {
        allow: ["brave"],
      },
      channels: {
        discord: {
          enabled: true,
          token: "configured",
        },
      },
    });

    expect(hits).toEqual([
      {
        channelId: "discord",
        pluginId: "discord",
        reason: "not in allowlist",
      },
    ]);
    expect(collectConfiguredChannelPluginBlockerWarnings(hits)).toEqual([
      '- channels.discord: channel is configured, but plugin "discord" is installed but omitted from plugins.allow. Include "discord" in plugins.allow. Fix plugin enablement before relying on setup guidance for this channel.',
    ]);
  });

  it("keeps blocker reasons scoped to each external owner", () => {
    mockManifestPlugins([
      plugin("denied-chat", { origin: "config", channelId: "shared-chat" }),
      plugin("untrusted-chat", { origin: "config", channelId: "shared-chat" }),
    ]);

    const hits = scanConfiguredChannelPluginBlockers({
      plugins: {
        deny: ["denied-chat"],
      },
      channels: {
        "shared-chat": {
          token: "configured",
        },
      },
    });

    expect(hits).toEqual([
      {
        channelId: "shared-chat",
        pluginId: "denied-chat",
        reason: "blocked by denylist",
      },
      {
        channelId: "shared-chat",
        pluginId: "untrusted-chat",
        reason: "missing explicit enablement",
      },
    ]);
    expect(collectConfiguredChannelPluginBlockerWarnings(hits)).toEqual([
      '- channels.shared-chat: channel is configured, but plugin "denied-chat" is blocked by plugins.deny. Remove "denied-chat" from plugins.deny. Fix plugin enablement before relying on setup guidance for this channel.',
      '- channels.shared-chat: channel is configured, but external plugin "untrusted-chat" is installed without explicit trust. Add plugins.entries.untrusted-chat.enabled=true. Fix plugin enablement before relying on setup guidance for this channel.',
    ]);
  });

  it("accepts workspace channel owners activated through a plugin slot", () => {
    mockManifestPlugins([
      plugin("workspace-chat", { origin: "workspace", channelId: "workspace-chat" }),
    ]);

    const hits = scanConfiguredChannelPluginBlockers({
      plugins: {
        allow: ["browser"],
        slots: {
          contextEngine: "workspace-chat",
        },
      },
      channels: {
        "workspace-chat": {
          token: "configured",
        },
      },
    });

    expect(hits).toStrictEqual([]);
  });
});
