// Verifies outbound channel resolution fast paths, active-registry reads,
// bootstrap fallback, and runtime facade projection.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

const tryResolveAmbientOwnerAgentIdMock = vi.hoisted(() => vi.fn());
const resolveAgentWorkspaceDirMock = vi.hoisted(() => vi.fn());
const getLoadedChannelPluginMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());
const applyPluginAutoEnableMock = vi.hoisted(() => vi.fn());
const resolveDiscoverableScopedChannelPluginIdsMock = vi.hoisted(() => vi.fn());
const resolveRuntimePluginRegistryMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryVersionMock = vi.hoisted(() => vi.fn());
const normalizeMessageChannelMock = vi.hoisted(() => vi.fn());
const isDeliverableMessageChannelMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/agent-scope.js", () => ({
  tryResolveAmbientOwnerAgentId: (...args: unknown[]) => tryResolveAmbientOwnerAgentIdMock(...args),
  resolveAgentWorkspaceDir: (...args: unknown[]) => resolveAgentWorkspaceDirMock(...args),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: (...args: unknown[]) => getLoadedChannelPluginMock(...args),
  getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnableMock(...args),
}));

vi.mock("../../plugins/channel-plugin-ids.js", () => ({
  resolveDiscoverableScopedChannelPluginIds: (...args: unknown[]) =>
    resolveDiscoverableScopedChannelPluginIdsMock(...args),
}));

vi.mock("../../plugins/loader.js", () => ({
  loadPluginRegistryHandle: (...args: unknown[]) => resolveRuntimePluginRegistryMock(...args),
}));

vi.mock("../../plugins/plugin-metadata-state-worker.js", () => ({
  readPluginMetadataStateRow: vi.fn(async () => undefined),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: (...args: unknown[]) => getActivePluginRegistryMock(...args),
  getActivePluginRegistryVersion: (...args: unknown[]) =>
    getActivePluginRegistryVersionMock(...args),
}));

vi.mock("../../utils/message-channel.js", () => ({
  INTERNAL_MESSAGE_CHANNEL: "webchat",
  normalizeMessageChannel: (...args: unknown[]) => normalizeMessageChannelMock(...args),
  isDeliverableMessageChannel: (...args: unknown[]) => isDeliverableMessageChannelMock(...args),
}));

let channelResolution: typeof import("./channel-resolution.js");
let withPluginRuntimeRegistryScope: typeof import("../../plugins/runtime/gateway-request-scope.js").withPluginRuntimeRegistryScope;

beforeAll(async () => {
  vi.resetModules();
  ({ withPluginRuntimeRegistryScope } =
    await import("../../plugins/runtime/gateway-request-scope.js"));
  channelResolution = await import("./channel-resolution.js");
});

describe("outbound channel resolution", () => {
  beforeEach(() => {
    tryResolveAmbientOwnerAgentIdMock.mockReset();
    resolveAgentWorkspaceDirMock.mockReset();
    getLoadedChannelPluginMock.mockReset();
    getChannelPluginMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    resolveDiscoverableScopedChannelPluginIdsMock.mockReset();
    resolveRuntimePluginRegistryMock.mockReset();
    getActivePluginRegistryMock.mockReset();
    getActivePluginRegistryVersionMock.mockReset();
    normalizeMessageChannelMock.mockReset();
    isDeliverableMessageChannelMock.mockReset();

    normalizeMessageChannelMock.mockImplementation((value?: string | null) =>
      typeof value === "string" ? value.trim().toLowerCase() : undefined,
    );
    isDeliverableMessageChannelMock.mockImplementation((value?: string) =>
      ["alpha", "beta", "gamma"].includes(String(value)),
    );
    getActivePluginRegistryMock.mockReturnValue({ channels: [] });
    getActivePluginRegistryVersionMock.mockReturnValue(1);
    applyPluginAutoEnableMock.mockReturnValue({
      config: { autoEnabled: true },
      autoEnabledReasons: {},
    });
    resolveDiscoverableScopedChannelPluginIdsMock.mockReturnValue(["alpha-plugin"]);
    resolveRuntimePluginRegistryMock.mockReturnValue({ channels: [] });
    tryResolveAmbientOwnerAgentIdMock.mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");
  });

  it.each([
    { input: " Alpha ", expected: "alpha" },
    { input: "unknown", expected: undefined },
  ])("normalizes deliverable outbound channel for %j", async ({ input, expected }) => {
    expect(channelResolution.normalizeDeliverableOutboundChannel(input)).toBe(expected);
  });

  it.each(["loaded"] as const)(
    "does not borrow a %s message adapter from a scoped outbound-only registration",
    async (fallback) => {
      const sibling = { id: "alpha", message: { send: { text: vi.fn() } } };
      (fallback === "loaded" ? getLoadedChannelPluginMock : getChannelPluginMock).mockReturnValue(
        sibling,
      );
      const scoped = {
        ...createChannelTestPluginBase({ id: "alpha" }),
        outbound: { deliveryMode: "direct" as const, sendText: vi.fn() },
      };
      const registry = createTestRegistry([{ pluginId: "scoped", plugin: scoped, source: "test" }]);

      await withPluginRuntimeRegistryScope(registry, async () => {
        expect(channelResolution.resolveOutboundChannelPlugin({ channel: "alpha" })).toBe(scoped);
        expect(
          await channelResolution.resolveOutboundChannelMessageAdapter({ channel: "alpha" }),
        ).toBeUndefined();
      });
      expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
    },
  );

  it("keeps a bootstrapped external alias available to normal runtime lookups", async () => {
    const message = { send: { text: vi.fn() } };
    const plugin = {
      id: "external-channel",
      meta: { aliases: ["external"] },
      message,
    };
    isDeliverableMessageChannelMock.mockReturnValue(false);
    getLoadedChannelPluginMock.mockReturnValue(undefined);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginRegistryMock.mockImplementation(() =>
      resolveRuntimePluginRegistryMock.mock.calls.length > 0 ? { channels: [{ plugin }] } : null,
    );

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "external",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBe(plugin);
    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "external",
        cfg: { channels: {} } as never,
      }),
    ).toBe(plugin);
    expect(
      await channelResolution.resolveOutboundChannelMessageAdapter({
        channel: "external",
        cfg: { channels: {} } as never,
      }),
    ).toBe(message);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("bootstraps instead of returning direct outbound metadata from a setup shell", async () => {
    const setupPlugin = { id: "alpha", outbound: { deliveryMode: "direct" } };
    const runtimePlugin = { id: "alpha", outbound: { deliveryMode: "direct", sendText: vi.fn() } };
    getLoadedChannelPluginMock.mockReturnValue(setupPlugin);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginRegistryMock.mockImplementation(() =>
      resolveRuntimePluginRegistryMock.mock.calls.length > 0
        ? { channels: [{ plugin: runtimePlugin }] }
        : { channels: [{ plugin: setupPlugin }] },
    );

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBe(runtimePlugin);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("bootstraps an external channel before resolving its message adapter", async () => {
    const message = { send: { text: vi.fn() } };
    const plugin = { id: "external-channel", message };
    isDeliverableMessageChannelMock.mockImplementation(
      (value?: string) =>
        value === "external-channel" && resolveRuntimePluginRegistryMock.mock.calls.length > 0,
    );
    getLoadedChannelPluginMock.mockImplementation(() =>
      resolveRuntimePluginRegistryMock.mock.calls.length > 0 ? plugin : undefined,
    );

    expect(
      await channelResolution.resolveOutboundChannelMessageAdapter({
        channel: "external-channel",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBe(message);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("does not bootstrap by default for outbound hot-path resolution", async () => {
    const plugin = { id: "alpha" };
    getLoadedChannelPluginMock.mockReturnValue(undefined);
    getChannelPluginMock.mockReturnValue(plugin);

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
      }),
    ).toBe(plugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });
});
