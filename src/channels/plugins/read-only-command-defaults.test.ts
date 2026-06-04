import { beforeEach, describe, expect, it, vi } from "vitest";

const loadPluginMetadataSnapshot = vi.hoisted(() => vi.fn());

vi.mock("../../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: loadPluginMetadataSnapshot,
}));

import { resolveReadOnlyChannelCommandDefaults } from "./read-only-command-defaults.js";

describe("resolveReadOnlyChannelCommandDefaults", () => {
  beforeEach(() => {
    loadPluginMetadataSnapshot.mockReset();
    loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      plugins: [],
    });
  });

  it("resolves command defaults from the shared metadata snapshot", () => {
    const env = { HOME: "/home/demo" } as NodeJS.ProcessEnv;
    loadPluginMetadataSnapshot.mockReturnValue({
      index: {
        plugins: [
          {
            pluginId: "demo",
            origin: "global",
            enabled: true,
            enabledByDefault: true,
          },
        ],
      },
      plugins: [
        {
          id: "demo",
          origin: "global",
          channels: ["demo"],
          channelConfigs: {
            demo: {
              commands: {
                nativeCommandsAutoEnabled: true,
                nativeSkillsAutoEnabled: false,
              },
            },
          },
        },
      ],
    });

    expect(
      resolveReadOnlyChannelCommandDefaults("demo", {
        config: {},
        env,
        stateDir: "/state",
        workspaceDir: "/workspace",
      }),
    ).toEqual({
      nativeCommandsAutoEnabled: true,
      nativeSkillsAutoEnabled: false,
    });
    expect(loadPluginMetadataSnapshot).toHaveBeenCalledWith({
      allowWorkspaceScopedCurrent: true,
      config: {},
      env,
      stateDir: "/state",
      workspaceDir: "/workspace",
    });
  });

  it("resolves command defaults for manifest channel aliases", () => {
    loadPluginMetadataSnapshot.mockReturnValue({
      index: {
        plugins: [
          {
            pluginId: "vendor-demo-plugin",
            origin: "global",
            enabled: true,
            enabledByDefault: true,
          },
        ],
      },
      plugins: [
        {
          id: "vendor-demo-plugin",
          origin: "global",
          channels: ["demo"],
          channelConfigs: {
            demo: {
              commands: {
                nativeCommandsAutoEnabled: true,
                nativeSkillsAutoEnabled: false,
              },
            },
          },
        },
      ],
    });

    expect(
      resolveReadOnlyChannelCommandDefaults("demo", {
        config: {},
      }),
    ).toEqual({
      nativeCommandsAutoEnabled: true,
      nativeSkillsAutoEnabled: false,
    });
  });

  it("skips unreadable plugin metadata rows while resolving command defaults", () => {
    const unreadableChannels = Object.defineProperty(
      {
        id: "poisoned-channels",
        origin: "global",
      },
      "channels",
      {
        get() {
          throw new Error("read-only command channels exploded");
        },
      },
    );
    const unreadableChannelConfigs = Object.defineProperty(
      {
        id: "poisoned-channel-configs",
        origin: "global",
        channels: ["demo"],
      },
      "channelConfigs",
      {
        get() {
          throw new Error("read-only command config exploded");
        },
      },
    );
    loadPluginMetadataSnapshot.mockReturnValue({
      index: {
        plugins: [
          {
            pluginId: "poisoned-channel-configs",
            origin: "global",
            enabled: true,
            enabledByDefault: true,
          },
          {
            pluginId: "healthy-demo",
            origin: "global",
            enabled: true,
            enabledByDefault: true,
          },
        ],
      },
      plugins: [
        unreadableChannels,
        unreadableChannelConfigs,
        {
          id: "healthy-demo",
          origin: "global",
          channels: ["demo"],
          channelConfigs: {
            demo: {
              commands: {
                nativeCommandsAutoEnabled: true,
              },
            },
          },
        },
      ],
    });

    expect(
      resolveReadOnlyChannelCommandDefaults("demo", {
        config: {},
      }),
    ).toEqual({
      nativeCommandsAutoEnabled: true,
    });
  });
});
