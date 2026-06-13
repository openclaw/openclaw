// Channel plugin blocker tests cover doctor diagnostics for blocked channel plugin setup.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as manifestRegistry from "../../../plugins/manifest-registry.js";
import {
  collectConfiguredChannelPluginBlockerWarnings,
  scanConfiguredChannelPluginBlockers,
} from "./channel-plugin-blockers.js";

describe("channel plugin blockers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("skips plugin registry work when config has no configured channel surfaces", () => {
    const registrySpy = vi.spyOn(manifestRegistry, "loadPluginManifestRegistry");

    const hits = scanConfiguredChannelPluginBlockers({
      channels: {
        defaults: {
          groupPolicy: "disabled",
        },
      },
    });

    expect(hits).toStrictEqual([]);
    expect(registrySpy).not.toHaveBeenCalled();
  });

  it("reports external channel plugins that are installed but not explicitly enabled", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "discord",
          origin: "global",
          channels: ["discord"],
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

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
  });

  it("accepts plugins.allow as explicit trust for external channel plugins", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "discord",
          origin: "global",
          channels: ["discord"],
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

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

  it("diagnoses trust from the pre-auto-enable config", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "discord",
          origin: "global",
          channels: ["discord"],
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const channels = {
      discord: {
        enabled: true,
        token: "configured",
      },
    };
    const hits = scanConfiguredChannelPluginBlockers(
      {
        channels,
        plugins: {
          entries: {
            discord: { enabled: true },
          },
        },
      },
      process.env,
      { channels },
    );

    expect(hits).toEqual([
      {
        channelId: "discord",
        pluginId: "discord",
        reason: "missing explicit enablement",
      },
    ]);
  });

  it("reports external channel plugins omitted from a restrictive allowlist", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "discord",
          origin: "global",
          channels: ["discord"],
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

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
      '- channels.discord: channel is configured, but external plugin "discord" is installed but omitted from plugins.allow. Include "discord" in plugins.allow. Fix plugin enablement before relying on setup guidance for this channel.',
    ]);
  });

  it("still evaluates configured channels when plugins are disabled globally", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "slack",
          origin: "bundled",
          channels: ["slack"],
          enabledByDefault: true,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers({
      plugins: {
        enabled: false,
      },
      channels: {
        slack: {
          accounts: {
            work: {
              allowFrom: ["alice"],
            },
          },
        },
      },
    });

    expect(hits).toEqual([
      {
        channelId: "slack",
        pluginId: "slack",
        reason: "plugins disabled",
      },
    ]);
  });

  it("ignores ambient channel env when reporting plugin blockers", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "slack",
          origin: "bundled",
          channels: ["slack"],
          enabledByDefault: true,
        },
        {
          id: "telegram",
          origin: "bundled",
          channels: ["telegram"],
          enabledByDefault: true,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers(
      {
        plugins: {
          enabled: false,
        },
        channels: {
          telegram: {
            botToken: "configured",
          },
        },
      },
      {
        SLACK_BOT_TOKEN: "ambient",
      } as NodeJS.ProcessEnv,
    );

    expect(hits).toEqual([
      {
        channelId: "telegram",
        pluginId: "telegram",
        reason: "plugins disabled",
      },
    ]);
  });

  it("does not report a disabled bundled owner when a configured external plugin owns the channel", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "feishu",
          origin: "bundled",
          channels: ["feishu"],
          enabledByDefault: true,
        },
        {
          id: "openclaw-lark",
          origin: "config",
          channels: ["feishu"],
          enabledByDefault: false,
          channelConfigs: {
            feishu: {
              schema: {
                type: "object",
              },
            },
          },
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers({
      plugins: {
        entries: {
          feishu: {
            enabled: false,
          },
          "openclaw-lark": {
            enabled: true,
          },
        },
      },
      channels: {
        feishu: {
          footer: {
            model: false,
          },
        },
      },
    });

    expect(hits).toStrictEqual([]);
  });

  it("still reports the disabled bundled owner when an external channel owner is not trusted", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "feishu",
          origin: "bundled",
          channels: ["feishu"],
          enabledByDefault: true,
        },
        {
          id: "openclaw-lark",
          origin: "config",
          channels: ["feishu"],
          enabledByDefault: false,
          channelConfigs: {
            feishu: {
              schema: {
                type: "object",
              },
            },
          },
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers({
      plugins: {
        entries: {
          feishu: {
            enabled: false,
          },
        },
      },
      channels: {
        feishu: {
          footer: {
            model: false,
          },
        },
      },
    });

    expect(hits).toEqual([
      {
        channelId: "feishu",
        pluginId: "feishu",
        reason: "disabled in config",
      },
    ]);
  });
});
