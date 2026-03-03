import { beforeEach, describe, expect, it, vi } from "vitest";

const TEST_WORKSPACE_ROOT = "/tmp/openclaw-test-workspace";

const mocks = vi.hoisted(() => ({
  listChannelPlugins: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
}));

vi.mock("../../plugins/loader.js", () => ({
  loadOpenClawPlugins: mocks.loadOpenClawPlugins,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => TEST_WORKSPACE_ROOT,
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable(args: { config: unknown }) {
    return { config: args.config, changes: [] };
  },
}));

import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { resolveMessageChannelSelection } from "./channel-selection.js";

function createExtensionPlugin(id: string) {
  return createChannelTestPluginBase({
    id: id as never,
    label: id,
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
      isConfigured: async () => true,
    },
  });
}

describe("resolveMessageChannelSelection", () => {
  beforeEach(() => {
    mocks.listChannelPlugins.mockReset();
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.loadOpenClawPlugins.mockReset();
  });

  it("keeps explicit known channels and marks source explicit", async () => {
    const selection = await resolveMessageChannelSelection({
      cfg: {} as never,
      channel: "telegram",
    });

    expect(selection).toEqual({
      channel: "telegram",
      configured: [],
      source: "explicit",
    });
  });

  it("falls back to tool context channel when explicit channel is unknown", async () => {
    const selection = await resolveMessageChannelSelection({
      cfg: {} as never,
      channel: "channel:C123",
      fallbackChannel: "slack",
    });

    expect(selection).toEqual({
      channel: "slack",
      configured: [],
      source: "tool-context-fallback",
    });
  });

  it("uses fallback channel when explicit channel is omitted", async () => {
    const selection = await resolveMessageChannelSelection({
      cfg: {} as never,
      fallbackChannel: "signal",
    });

    expect(selection).toEqual({
      channel: "signal",
      configured: [],
      source: "tool-context-fallback",
    });
  });

  it("selects single configured channel when no explicit/fallback channel exists", async () => {
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "discord",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
          isConfigured: async () => true,
        },
      },
    ]);

    const selection = await resolveMessageChannelSelection({
      cfg: {} as never,
    });

    expect(selection).toEqual({
      channel: "discord",
      configured: ["discord"],
      source: "single-configured",
    });
  });

  it("throws unknown channel when explicit and fallback channels are both invalid", async () => {
    await expect(
      resolveMessageChannelSelection({
        cfg: {} as never,
        channel: "channel:C123",
        fallbackChannel: "not-a-channel",
      }),
    ).rejects.toThrow("Unknown channel: channel:c123");
  });
});

describe("resolveMessageChannelSelection bootstrap recovery", () => {
  let registrySeq = 0;

  beforeEach(() => {
    registrySeq += 1;
    // Start with an empty registry (no channel plugins loaded).
    setActivePluginRegistry(createTestRegistry([]), `sel-test-${registrySeq}`);
    mocks.listChannelPlugins.mockReset();
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.loadOpenClawPlugins.mockReset();
  });

  it("bootstraps plugins when an extension channel is not yet in the registry", async () => {
    const extensionPlugin = createExtensionPlugin("msteams");

    // When loadOpenClawPlugins is called, populate the registry with the plugin.
    mocks.loadOpenClawPlugins.mockImplementation(() => {
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "msteams", source: "test", plugin: extensionPlugin }]),
        `sel-test-${registrySeq}`,
      );
    });

    const result = await resolveMessageChannelSelection({
      channel: "msteams",
      cfg: { channels: { msteams: {} } } as never,
    });

    expect(result.channel).toBe("msteams");
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
  });

  it("throws Unknown channel when bootstrap does not resolve the channel", async () => {
    // loadOpenClawPlugins is called but doesn't add the channel.
    mocks.loadOpenClawPlugins.mockImplementation(() => {});

    await expect(
      resolveMessageChannelSelection({
        channel: "nonexistent",
        cfg: { channels: {} } as never,
      }),
    ).rejects.toThrow("Unknown channel: nonexistent");

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
  });

  it("falls back to fallbackChannel after bootstrap fails to resolve an opaque id", async () => {
    mocks.loadOpenClawPlugins.mockImplementation(() => {});

    const result = await resolveMessageChannelSelection({
      channel: "C12345678",
      fallbackChannel: "slack",
      cfg: { channels: {} } as never,
    });

    expect(result).toMatchObject({
      channel: "slack",
      source: "tool-context-fallback",
    });
    // Bootstrap is attempted for the unrecognized channel before falling back.
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
  });

  it("skips bootstrap when the channel is already known (built-in)", async () => {
    // Built-in channels like "discord" are always in CHANNEL_IDS and don't
    // need bootstrap. loadOpenClawPlugins should not be called.
    const result = await resolveMessageChannelSelection({
      channel: "discord",
      cfg: { channels: { discord: {} } } as never,
    });

    expect(result.channel).toBe("discord");
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });
});
