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
      '- channels.discord: channel is configured, but external plugin "discord" is installed without explicit trust. Add plugins.entries.discord.enabled=true or include "discord" in plugins.allow. Fix plugin enablement before relying on setup guidance for this channel.',
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
