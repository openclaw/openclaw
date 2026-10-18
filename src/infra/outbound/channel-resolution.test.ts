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
  tryResolveAmbientOwnerAgentId: tryResolveAmbientOwnerAgentIdMock,
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: getLoadedChannelPluginMock,
  getChannelPlugin: getChannelPluginMock,
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: applyPluginAutoEnableMock,
}));

vi.mock("../../plugins/channel-plugin-ids.js", () => ({
  resolveDiscoverableScopedChannelPluginIds: resolveDiscoverableScopedChannelPluginIdsMock,
}));

vi.mock("../../plugins/loader.js", () => ({
  loadPluginRegistryHandle: resolveRuntimePluginRegistryMock,
}));

vi.mock("../../plugins/plugin-metadata-state-worker.js", () => ({
  readPluginMetadataStateRow: vi.fn(async () => undefined),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: getActivePluginRegistryMock,
  getActivePluginRegistryVersion: getActivePluginRegistryVersionMock,
}));

vi.mock("../../utils/message-channel.js", () => ({
  INTERNAL_MESSAGE_CHANNEL: "webchat",
  normalizeMessageChannel: normalizeMessageChannelMock,
  isDeliverableMessageChannel: isDeliverableMessageChannelMock,
}));

let channelResolution: typeof import("./channel-resolution.js");
let withPluginRuntimeRegistryScope: typeof import("../../plugins/runtime/gateway-request-scope.js").withPluginRuntimeRegistryScope;

beforeAll(async () => {
  vi.resetModules();
  ({ withPluginRuntimeRegistryScope } =
    await import("../../plugins/runtime/gateway-request-scope.js"));
  channelResolution = await import("./channel-resolution.js");
});

function resolvePlugin(channel: string, allowBootstrap?: true) {
  return channelResolution.resolveOutboundChannelPlugin({
    channel,
    cfg: { channels: {} },
    ...(allowBootstrap ? { allowBootstrap } : {}),
  });
}

function resolveMessage(channel: string, allowBootstrap?: true) {
  return channelResolution.resolveOutboundChannelMessageAdapter({
    channel,
    cfg: { channels: {} },
    ...(allowBootstrap ? { allowBootstrap } : {}),
  });
}

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

  it("does not borrow a loaded message adapter from a scoped outbound-only registration", async () => {
    const sibling = { id: "alpha", message: { send: { text: vi.fn() } } };
    getLoadedChannelPluginMock.mockReturnValue(sibling);
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
  });

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

    expect(resolvePlugin("external", true)).toBe(plugin);
    expect(resolvePlugin("external")).toBe(plugin);
    expect(await resolveMessage("external")).toBe(message);
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

    expect(resolvePlugin("alpha", true)).toBe(runtimePlugin);
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

    expect(await resolveMessage("external-channel", true)).toBe(message);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("does not bootstrap by default for outbound hot-path resolution", async () => {
    const plugin = { id: "alpha" };
    getLoadedChannelPluginMock.mockReturnValue(undefined);
    getChannelPluginMock.mockReturnValue(plugin);

    expect(resolvePlugin("alpha")).toBe(plugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });
});
