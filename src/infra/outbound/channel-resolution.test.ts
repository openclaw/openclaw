import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveDefaultAgentIdMock = vi.hoisted(() => vi.fn());
const resolveAgentWorkspaceDirMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());
const applyPluginAutoEnableMock = vi.hoisted(() => vi.fn());
const resolveRuntimePluginRegistryMock = vi.hoisted(() => vi.fn());
const getActivePluginChannelRegistryMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryMock = vi.hoisted(() => vi.fn());
const getActivePluginChannelRegistryMock = vi.hoisted(() => vi.fn());
const getActivePluginChannelRegistryVersionMock = vi.hoisted(() => vi.fn());
const normalizeMessageChannelMock = vi.hoisted(() => vi.fn());
const isDeliverableMessageChannelMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: (...args: unknown[]) => resolveDefaultAgentIdMock(...args),
  resolveAgentWorkspaceDir: (...args: unknown[]) => resolveAgentWorkspaceDirMock(...args),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnableMock(...args),
}));

vi.mock("../../plugins/loader.js", () => ({
  resolveRuntimePluginRegistry: (...args: unknown[]) => resolveRuntimePluginRegistryMock(...args),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginChannelRegistry: (...args: unknown[]) =>
    getActivePluginChannelRegistryMock(...args),
  getActivePluginRegistry: (...args: unknown[]) => getActivePluginRegistryMock(...args),
  getActivePluginChannelRegistry: (...args: unknown[]) =>
    getActivePluginChannelRegistryMock(...args),
  getActivePluginChannelRegistryVersion: (...args: unknown[]) =>
    getActivePluginChannelRegistryVersionMock(...args),
}));

vi.mock("../../utils/message-channel.js", () => ({
  normalizeMessageChannel: (...args: unknown[]) => normalizeMessageChannelMock(...args),
  isDeliverableMessageChannel: (...args: unknown[]) => isDeliverableMessageChannelMock(...args),
}));

import { importFreshModule } from "../../../test/helpers/import-fresh.js";

async function importChannelResolution(scope: string) {
  return await importFreshModule<typeof import("./channel-resolution.js")>(
    import.meta.url,
    `./channel-resolution.js?scope=${scope}`,
  );
}

function expectBootstrapArgs() {
  expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
    expect.objectContaining({
      config: { autoEnabled: true },
      activationSourceConfig: { channels: {} },
      workspaceDir: "/tmp/workspace",
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    }),
  );
}

describe("outbound channel resolution", () => {
  beforeEach(async () => {
    resolveDefaultAgentIdMock.mockReset();
    resolveAgentWorkspaceDirMock.mockReset();
    getChannelPluginMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    resolveRuntimePluginRegistryMock.mockReset();
    getActivePluginChannelRegistryMock.mockReset();
    getActivePluginRegistryMock.mockReset();
    getActivePluginChannelRegistryMock.mockReset();
    getActivePluginChannelRegistryVersionMock.mockReset();
    normalizeMessageChannelMock.mockReset();
    isDeliverableMessageChannelMock.mockReset();

    normalizeMessageChannelMock.mockImplementation((value?: string | null) =>
      typeof value === "string" ? value.trim().toLowerCase() : undefined,
    );
    isDeliverableMessageChannelMock.mockImplementation((value?: string) =>
      ["telegram", "discord", "slack"].includes(String(value)),
    );
    getActivePluginChannelRegistryMock.mockReturnValue(null);
    getActivePluginRegistryMock.mockReturnValue({ channels: [] });
    getActivePluginChannelRegistryMock.mockReturnValue({ channels: [] });
    getActivePluginChannelRegistryVersionMock.mockReturnValue(1);
    applyPluginAutoEnableMock.mockReturnValue({
      config: { autoEnabled: true },
      autoEnabledReasons: {},
    });
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");

    const channelResolution = await importChannelResolution("reset");
    channelResolution.resetOutboundChannelResolutionStateForTest();
  });

  it.each([
    { input: " Telegram ", expected: "telegram" },
    { input: "unknown", expected: undefined },
    { input: null, expected: undefined },
  ])("normalizes deliverable outbound channel for %j", async ({ input, expected }) => {
    const channelResolution = await importChannelResolution("normalize");
    expect(channelResolution.normalizeDeliverableOutboundChannel(input)).toBe(expected);
  });

  it("returns the already-registered plugin without bootstrapping", async () => {
    const plugin = { id: "telegram" };
    getChannelPluginMock.mockReturnValueOnce(plugin);
    const channelResolution = await importChannelResolution("existing-plugin");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "telegram",
        cfg: {} as never,
      }),
    ).toBe(plugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("falls back to the active registry when getChannelPlugin misses", async () => {
    const plugin = { id: "telegram" };
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin }],
    });
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin }],
    });
    const channelResolution = await importChannelResolution("direct-registry");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "telegram",
        cfg: {} as never,
      }),
    ).toBe(plugin);
  });

  it("bootstraps plugins once per registry key and returns the newly loaded plugin", async () => {
    const plugin = { id: "telegram" };
    getChannelPluginMock.mockReturnValueOnce(undefined).mockReturnValueOnce(plugin);
    const channelResolution = await importChannelResolution("bootstrap-success");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "telegram",
        cfg: { channels: {} } as never,
      }),
    ).toBe(plugin);
    expectBootstrapArgs();

    getChannelPluginMock.mockReturnValue(undefined);
    channelResolution.resolveOutboundChannelPlugin({
      channel: "telegram",
      cfg: { channels: {} } as never,
    });
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
    expectBootstrapArgs();
  });

  it("bootstraps when the active registry has other channels but not the requested one", async () => {
    const plugin = { id: "telegram" };
    getChannelPluginMock.mockReturnValueOnce(undefined).mockReturnValueOnce(plugin);
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin: { id: "discord" } }],
    });
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: { id: "discord" } }],
    });
    const channelResolution = await importChannelResolution("bootstrap-missing-target");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "telegram",
        cfg: { channels: {} } as never,
      }),
    ).toBe(plugin);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("retries bootstrap after a transient load failure", async () => {
    getChannelPluginMock.mockReturnValue(undefined);
    resolveRuntimePluginRegistryMock.mockImplementationOnce(() => {
      throw new Error("transient");
    });
    const channelResolution = await importChannelResolution("bootstrap-retry");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "telegram",
        cfg: { channels: {} } as never,
      }),
    ).toBeUndefined();

    channelResolution.resolveOutboundChannelPlugin({
      channel: "telegram",
      cfg: { channels: {} } as never,
    });
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(2);
  });

  it("retries bootstrap when the pinned channel registry version changes", async () => {
    getChannelPluginMock.mockReturnValue(undefined);
    const channelResolution = await importChannelResolution("channel-version-change");

    channelResolution.resolveOutboundChannelPlugin({
      channel: "telegram",
      cfg: { channels: {} } as never,
    });
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);

    getActivePluginChannelRegistryVersionMock.mockReturnValue(2);
    channelResolution.resolveOutboundChannelPlugin({
      channel: "telegram",
      cfg: { channels: {} } as never,
    });
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(2);
  });

  it("resolves from pinned channel registry when active registry lost the channel (subagent split-brain)", async () => {
    const plugin = { id: "telegram" };
    // getChannelPlugin returns the plugin (since the pinned registry feeds it)
    getChannelPluginMock.mockReturnValue(plugin);
    // Pinned channel registry has the channel
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin }],
    });
    // But mutable active registry has lost it (subagent swap evicted it)
    getActivePluginRegistryMock.mockReturnValue({ channels: [] });

    const channelResolution = await importChannelResolution("pinned-split-brain");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "telegram",
        cfg: {} as never,
      }),
    ).toBe(plugin);
    // Should NOT attempt bootstrap since pinned registry has the channel
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("falls back to direct pinned registry lookup when getChannelPlugin misses but pinned registry has entry", async () => {
    const plugin = { id: "telegram" };
    // getChannelPlugin misses (e.g. cache stale)
    getChannelPluginMock.mockReturnValue(undefined);
    // Pinned channel registry has the channel
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin }],
    });
    // Mutable active registry lost it
    getActivePluginRegistryMock.mockReturnValue({ channels: [] });

    const channelResolution = await importChannelResolution("pinned-direct-fallback");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "telegram",
        cfg: {} as never,
      }),
    ).toBe(plugin);
    // No bootstrap needed — found in pinned registry
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("skips bootstrap when pinned registry already has the requested channel", async () => {
    const plugin = { id: "telegram" };
    getChannelPluginMock
      .mockReturnValueOnce(undefined) // first resolve() misses
      .mockReturnValueOnce(undefined); // second resolve() also misses (would be after bootstrap)
    // Pinned registry has the channel
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin }],
    });
    // Mutable registry does not
    getActivePluginRegistryMock.mockReturnValue({ channels: [] });

    const channelResolution = await importChannelResolution("pinned-skip-bootstrap");

    const result = channelResolution.resolveOutboundChannelPlugin({
      channel: "telegram",
      cfg: { channels: {} } as never,
    });
    // Should NOT bootstrap since pinned registry has the channel
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
    // Plugin should still be resolved via the pinned registry
    expect(result).toBe(plugin);
  });
});
