// Verifies outbound channel resolution fast paths, active-registry reads,
// bootstrap fallback, and runtime facade projection.
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveDefaultAgentIdMock = vi.hoisted(() => vi.fn());
const resolveAgentWorkspaceDirMock = vi.hoisted(() => vi.fn());
const getLoadedChannelPluginMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());
const applyPluginAutoEnableMock = vi.hoisted(() => vi.fn());
const resolveRuntimePluginRegistryMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryVersionMock = vi.hoisted(() => vi.fn());
const getActivePluginChannelRegistryMock = vi.hoisted(() => vi.fn());
const getActivePluginChannelRegistryVersionMock = vi.hoisted(() => vi.fn());
const normalizeMessageChannelMock = vi.hoisted(() => vi.fn());
const isDeliverableMessageChannelMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: (...args: unknown[]) => resolveDefaultAgentIdMock(...args),
  resolveAgentWorkspaceDir: (...args: unknown[]) => resolveAgentWorkspaceDirMock(...args),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: (...args: unknown[]) => getLoadedChannelPluginMock(...args),
  getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnableMock(...args),
}));

vi.mock("../../plugins/loader.js", () => ({
  resolveRuntimePluginRegistry: (...args: unknown[]) => resolveRuntimePluginRegistryMock(...args),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: (...args: unknown[]) => getActivePluginRegistryMock(...args),
  getActivePluginRegistryVersion: (...args: unknown[]) =>
    getActivePluginRegistryVersionMock(...args),
  getActivePluginChannelRegistry: (...args: unknown[]) =>
    getActivePluginChannelRegistryMock(...args),
  getActivePluginChannelRegistryVersion: (...args: unknown[]) =>
    getActivePluginChannelRegistryVersionMock(...args),
}));

vi.mock("../../utils/message-channel.js", () => ({
  INTERNAL_MESSAGE_CHANNEL: "webchat",
  normalizeMessageChannel: (...args: unknown[]) => normalizeMessageChannelMock(...args),
  isDeliverableMessageChannel: (...args: unknown[]) => isDeliverableMessageChannelMock(...args),
}));

import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";

async function importChannelResolution(scope: string) {
  return await importFreshModule<typeof import("./channel-resolution.js")>(
    import.meta.url,
    `./channel-resolution.js?scope=${scope}`,
  );
}

function firstMockArg(mock: { mock: { calls: readonly unknown[][] } }): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected mock call");
  }
  const [arg] = call;
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    throw new Error("expected mock call arg to be an object");
  }
  return arg as Record<string, unknown>;
}

function createSendingPlugin(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    message: { send: { text: vi.fn() } },
    ...overrides,
  };
}

describe("outbound channel resolution", () => {
  beforeEach(async () => {
    resolveDefaultAgentIdMock.mockReset();
    resolveAgentWorkspaceDirMock.mockReset();
    getLoadedChannelPluginMock.mockReset();
    getChannelPluginMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    resolveRuntimePluginRegistryMock.mockReset();
    getActivePluginRegistryMock.mockReset();
    getActivePluginRegistryVersionMock.mockReset();
    getActivePluginChannelRegistryMock.mockReset();
    getActivePluginChannelRegistryVersionMock.mockReset();
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
    { input: " Alpha ", expected: "alpha" },
    { input: "unknown", expected: undefined },
    { input: null, expected: undefined },
  ])("normalizes deliverable outbound channel for %j", async ({ input, expected }) => {
    const channelResolution = await importChannelResolution("normalize");
    expect(channelResolution.normalizeDeliverableOutboundChannel(input)).toBe(expected);
  });

  it("returns the already-registered plugin without bootstrapping", async () => {
    const plugin = createSendingPlugin("alpha");
    getLoadedChannelPluginMock.mockReturnValueOnce(plugin);
    const channelResolution = await importChannelResolution("existing-plugin");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: {} as never,
      }),
    ).toBe(plugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("returns a bundled plugin without bootstrapping", async () => {
    const plugin = createSendingPlugin("alpha");
    getLoadedChannelPluginMock.mockReturnValue(undefined);
    getChannelPluginMock.mockReturnValue(plugin);
    const channelResolution = await importChannelResolution("bundled-plugin");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: {} as never,
        allowBootstrap: true,
      }),
    ).toBe(plugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("falls back to the active registry when getChannelPlugin misses", async () => {
    const plugin = createSendingPlugin("alpha");
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
        channel: "alpha",
        cfg: {} as never,
      }),
    ).toBe(plugin);
  });

  it("resolves message adapters from the pinned channel registry after active registry replacement", async () => {
    const message = { send: { text: vi.fn() } };
    const plugin = { id: "alpha", message };
    getLoadedChannelPluginMock.mockReturnValue(undefined);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin }],
    });
    getActivePluginRegistryMock.mockReturnValue({ channels: [] });
    const channelResolution = await importChannelResolution("pinned-message-registry");

    expect(
      channelResolution.resolveOutboundChannelMessageAdapter({
        channel: "alpha",
        cfg: {} as never,
      }),
    ).toBe(message);
  });

  it("skips metadata-only loaded message shells for active send-capable message adapters", async () => {
    const setupMessage = { receive: { defaultAckPolicy: "manual" } };
    const runtimeMessage = { send: { text: vi.fn() } };
    const setupPlugin = { id: "alpha", message: setupMessage };
    const runtimePlugin = { id: "alpha", message: runtimeMessage };
    getLoadedChannelPluginMock.mockReturnValue(setupPlugin);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: setupPlugin }],
    });
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin: runtimePlugin }],
    });
    const channelResolution = await importChannelResolution("message-metadata-shell");

    expect(
      channelResolution.resolveOutboundChannelMessageAdapter({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBe(runtimeMessage);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("bootstraps configured channel plugins when the active registry is missing the target", async () => {
    const plugin = createSendingPlugin("alpha");
    getLoadedChannelPluginMock.mockReturnValueOnce(undefined).mockReturnValueOnce(plugin);
    const channelResolution = await importChannelResolution("bootstrap-missing-target");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBe(plugin);
    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({ config: { channels: {} } });
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledOnce();
    const registryOptions = firstMockArg(resolveRuntimePluginRegistryMock);
    expect(registryOptions.config).toEqual({ autoEnabled: true });
    expect(registryOptions.activationSourceConfig).toEqual({ channels: {} });
    expect(registryOptions.autoEnabledReasons).toEqual({});
    expect(registryOptions.workspaceDir).toBe("/tmp/workspace");
    expect(registryOptions.runtimeOptions).toEqual({
      allowGatewaySubagentBinding: true,
    });
  });

  it("bootstraps an external channel before strict deliverability validation", async () => {
    const plugin = { id: "external-channel", outbound: { sendText: vi.fn() } };
    isDeliverableMessageChannelMock.mockImplementation(
      (value?: string) =>
        value === "external-channel" && resolveRuntimePluginRegistryMock.mock.calls.length > 0,
    );
    getLoadedChannelPluginMock.mockImplementation(() =>
      resolveRuntimePluginRegistryMock.mock.calls.length > 0 ? plugin : undefined,
    );
    const channelResolution = await importChannelResolution("bootstrap-external-channel");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "external-channel",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBe(plugin);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("resolves a bootstrapped external channel from the active registry when the pin is stale", async () => {
    const plugin = { id: "external-channel", outbound: { sendText: vi.fn() } };
    isDeliverableMessageChannelMock.mockReturnValue(false);
    getLoadedChannelPluginMock.mockReturnValue(undefined);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: { id: "other-channel" } }],
    });
    getActivePluginRegistryMock.mockReturnValue({ channels: [{ plugin }] });
    const channelResolution = await importChannelResolution("bootstrap-external-active-registry");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "external-channel",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBe(plugin);
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
    getActivePluginChannelRegistryMock.mockReturnValue({ channels: [] });
    getActivePluginRegistryMock.mockImplementation(() =>
      resolveRuntimePluginRegistryMock.mock.calls.length > 0 ? { channels: [{ plugin }] } : null,
    );
    const channelResolution = await importChannelResolution("bootstrap-external-alias");

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
      channelResolution.resolveOutboundChannelMessageAdapter({
        channel: "external",
        cfg: { channels: {} } as never,
      }),
    ).toBe(message);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("bootstraps instead of returning a pinned setup shell as the outbound plugin", async () => {
    const setupPlugin = { id: "alpha" };
    const runtimePlugin = { id: "alpha", outbound: { sendText: vi.fn() } };
    getLoadedChannelPluginMock.mockReturnValueOnce(setupPlugin).mockReturnValueOnce(runtimePlugin);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginRegistryMock.mockReturnValue({ channels: [] });
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: setupPlugin }],
    });
    const channelResolution = await importChannelResolution("bootstrap-setup-shell");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBe(runtimePlugin);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("bootstraps instead of returning direct outbound metadata from a setup shell", async () => {
    const setupPlugin = { id: "alpha", outbound: { deliveryMode: "direct" } };
    const runtimePlugin = { id: "alpha", outbound: { deliveryMode: "direct", sendText: vi.fn() } };
    getLoadedChannelPluginMock.mockReturnValue(setupPlugin);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: setupPlugin }],
    });
    getActivePluginRegistryMock.mockImplementation(() =>
      resolveRuntimePluginRegistryMock.mock.calls.length > 0
        ? { channels: [{ plugin: runtimePlugin }] }
        : { channels: [{ plugin: setupPlugin }] },
    );
    const channelResolution = await importChannelResolution("bootstrap-outbound-metadata-shell");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBe(runtimePlugin);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("does not return a setup shell when bootstrap does not produce a runtime plugin", async () => {
    const setupPlugin = { id: "alpha" };
    getLoadedChannelPluginMock.mockReturnValue(setupPlugin);
    getChannelPluginMock.mockReturnValue(setupPlugin);
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin: setupPlugin }],
    });
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: setupPlugin }],
    });
    const channelResolution = await importChannelResolution("bootstrap-still-setup-shell");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBeUndefined();
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("does not treat an actions-only plugin as send-capable after bootstrap", async () => {
    const actionsOnlyPlugin = { id: "alpha", actions: { handleAction: vi.fn() } };
    getLoadedChannelPluginMock.mockReturnValue(actionsOnlyPlugin);
    getChannelPluginMock.mockReturnValue(actionsOnlyPlugin);
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin: actionsOnlyPlugin }],
    });
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: actionsOnlyPlugin }],
    });
    const channelResolution = await importChannelResolution("actions-only-plugin");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBeUndefined();
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("prefers an active runtime plugin over a loaded setup shell", async () => {
    const setupPlugin = { id: "alpha" };
    const runtimePlugin = { id: "alpha", outbound: { sendText: vi.fn() } };
    getLoadedChannelPluginMock.mockReturnValue(setupPlugin);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin: runtimePlugin }],
    });
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: setupPlugin }],
    });
    const channelResolution = await importChannelResolution("active-runtime-over-setup");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBe(runtimePlugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("resolves outbound plugins from the selected runtime channel registry", async () => {
    const setupPlugin = { id: "alpha" };
    const runtimePlugin = { id: "alpha", outbound: { sendText: vi.fn() } };
    getLoadedChannelPluginMock.mockReturnValue(undefined);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin: setupPlugin }],
    });
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: runtimePlugin }],
    });
    const channelResolution = await importChannelResolution("selected-runtime-registry");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBe(runtimePlugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("resolves runtime outbound adapters that do not send text directly", async () => {
    const setupPlugin = { id: "alpha" };
    const runtimePlugin = { id: "alpha", outbound: { deliveryMode: "gateway" } };
    getLoadedChannelPluginMock.mockReturnValue(setupPlugin);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin: runtimePlugin }],
    });
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: setupPlugin }],
    });
    const channelResolution = await importChannelResolution("runtime-outbound-adapter");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBe(runtimePlugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("attempts activation when the active registry has other channels but not the requested one", async () => {
    getLoadedChannelPluginMock.mockReturnValue(undefined);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin: createSendingPlugin("beta") }],
    });
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: createSendingPlugin("beta") }],
    });
    const channelResolution = await importChannelResolution("bootstrap-missing-target");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBeUndefined();
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("does not repeat registry loads after bootstrap misses in the same generation", async () => {
    getChannelPluginMock.mockReturnValue(undefined);
    const channelResolution = await importChannelResolution("bootstrap-retry");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBeUndefined();

    channelResolution.resolveOutboundChannelPlugin({
      channel: "alpha",
      cfg: { channels: {} } as never,
      allowBootstrap: true,
    });
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("allows another activation attempt when the pinned channel registry version changes", async () => {
    getChannelPluginMock.mockReturnValue(undefined);
    const channelResolution = await importChannelResolution("channel-version-change");

    channelResolution.resolveOutboundChannelPlugin({
      channel: "alpha",
      cfg: { channels: {} } as never,
      allowBootstrap: true,
    });
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);

    getActivePluginChannelRegistryVersionMock.mockReturnValue(2);
    channelResolution.resolveOutboundChannelPlugin({
      channel: "alpha",
      cfg: { channels: {} } as never,
      allowBootstrap: true,
    });
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(2);
  });

  it("allows another activation attempt when the active registry version changes", async () => {
    getChannelPluginMock.mockReturnValue(undefined);
    const channelResolution = await importChannelResolution("active-version-change");

    channelResolution.resolveOutboundChannelPlugin({
      channel: "alpha",
      cfg: { channels: {} } as never,
      allowBootstrap: true,
    });
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);

    getActivePluginRegistryVersionMock.mockReturnValue(2);
    channelResolution.resolveOutboundChannelPlugin({
      channel: "alpha",
      cfg: { channels: {} } as never,
      allowBootstrap: true,
    });
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(2);
  });

  it("resolves message adapters through the activation-aware channel plugin path", async () => {
    const message = { send: { text: vi.fn() } };
    const plugin = createSendingPlugin("alpha", { message });
    getLoadedChannelPluginMock.mockReturnValueOnce(undefined).mockReturnValueOnce(plugin);
    const channelResolution = await importChannelResolution("message-adapter-bootstrap");

    expect(
      channelResolution.resolveOutboundChannelMessageAdapter({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBe(message);
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
    const channelResolution = await importChannelResolution("message-adapter-external-channel");

    expect(
      channelResolution.resolveOutboundChannelMessageAdapter({
        channel: "external-channel",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBe(message);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("does not bootstrap by default for outbound hot-path resolution", async () => {
    const plugin = createSendingPlugin("alpha");
    getLoadedChannelPluginMock.mockReturnValue(undefined);
    getChannelPluginMock.mockReturnValue(plugin);
    const channelResolution = await importChannelResolution("no-bootstrap-default");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
      }),
    ).toBe(plugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("returns a setup-only loaded plugin from the shared resolver", async () => {
    const loadedPlugin = { id: "alpha" };
    getLoadedChannelPluginMock.mockReturnValue(loadedPlugin);
    const channelResolution = await importChannelResolution("setup-only-loaded");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: {} as never,
      }),
    ).toBe(loadedPlugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("setup-only plugin resolves from shared resolver but not delivery resolver", async () => {
    const actionOnlyPlugin = { id: "alpha", actions: { handleAction: vi.fn() } };
    getLoadedChannelPluginMock.mockReturnValue(actionOnlyPlugin);
    getActivePluginRegistryMock.mockReturnValue({ channels: [] });
    const channelResolution = await importChannelResolution("setup-only-delivery");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: {} as never,
      }),
    ).toBe(actionOnlyPlugin);

    expect(
      channelResolution.resolveOutboundChannelPluginForDelivery({
        channel: "alpha",
        cfg: {} as never,
        operation: "text",
      }),
    ).toBeUndefined();
  });

  it("delivery resolver skips setup-only loaded plugins and returns a sending registry fallback", async () => {
    const loadedPlugin = { id: "alpha" };
    const registryPlugin = createSendingPlugin("alpha");
    getLoadedChannelPluginMock.mockReturnValue(loadedPlugin);
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin: registryPlugin }],
    });
    const channelResolution = await importChannelResolution("delivery-setup-only-loaded");

    expect(
      channelResolution.resolveOutboundChannelPluginForDelivery({
        channel: "alpha",
        cfg: {} as never,
        operation: "text",
      }),
    ).toBe(registryPlugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("delivery resolver bootstraps a setup-only loaded plugin into a send-capable one when allowBootstrap is set", async () => {
    const setupShell = { id: "alpha" };
    const sendCapable = createSendingPlugin("alpha");
    // Loaded shell lacks send capability until bootstrap; active registry is empty so
    // bootstrap is forced, after which the loaded plugin resolves send-capable.
    getLoadedChannelPluginMock.mockReturnValueOnce(setupShell).mockReturnValue(sendCapable);
    getActivePluginRegistryMock.mockReturnValue({ channels: [] });
    const channelResolution = await importChannelResolution("delivery-bootstrap-setup-only");

    expect(
      channelResolution.resolveOutboundChannelPluginForDelivery({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
        operation: "text",
      }),
    ).toBe(sendCapable);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledOnce();
  });

  it("returns a plugin with only the legacy outbound text adapter", async () => {
    const plugin = createSendingPlugin("alpha", {
      message: undefined,
      outbound: { sendText: vi.fn() },
    });
    getLoadedChannelPluginMock.mockReturnValue(plugin);
    const channelResolution = await importChannelResolution("legacy-outbound-text");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: {} as never,
      }),
    ).toBe(plugin);
  });

  it("returns a plugin with only an outbound poll adapter", async () => {
    const plugin = createSendingPlugin("alpha", {
      message: undefined,
      outbound: { sendPoll: vi.fn() },
    });
    getLoadedChannelPluginMock.mockReturnValue(plugin);
    const channelResolution = await importChannelResolution("poll-only-outbound");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: {} as never,
      }),
    ).toBe(plugin);
  });

  it("delivery resolver rejects a media-only non-gateway plugin", async () => {
    // Direct/hybrid media rides createPluginHandler, which requires a text
    // sender; a media-only plugin is a false positive that fails later with
    // "Outbound not configured", so the delivery resolver must skip it.
    const mediaOnlyPlugin = {
      id: "alpha",
      outbound: { deliveryMode: "direct", sendMedia: vi.fn() },
    };
    getLoadedChannelPluginMock.mockReturnValue(mediaOnlyPlugin);
    getChannelPluginMock.mockReturnValue(mediaOnlyPlugin);
    getActivePluginRegistryMock.mockReturnValue({ channels: [] });
    const channelResolution = await importChannelResolution("delivery-media-only");

    expect(
      channelResolution.resolveOutboundChannelPluginForDelivery({
        channel: "alpha",
        cfg: {} as never,
        operation: "text",
      }),
    ).toBeUndefined();
  });

  it("delivery resolver resolves a gateway-mode plugin with no local send methods", async () => {
    const gatewayPlugin = { id: "alpha", outbound: { deliveryMode: "gateway" } };
    getLoadedChannelPluginMock.mockReturnValue(gatewayPlugin);
    const channelResolution = await importChannelResolution("delivery-gateway-only");

    // Gateway plugins deliver text through callMessageGateway with no local send
    // method, so the gateway short-circuit qualifies them for text.
    expect(
      channelResolution.resolveOutboundChannelPluginForDelivery({
        channel: "alpha",
        cfg: {} as never,
        operation: "text",
      }),
    ).toBe(gatewayPlugin);
    // But poll always requires outbound.sendPoll (the gateway poll path rejects a
    // pollless surface), so a gateway plugin without sendPoll must NOT resolve
    // for a poll send.
    expect(
      channelResolution.resolveOutboundChannelPluginForDelivery({
        channel: "alpha",
        cfg: {} as never,
        operation: "poll",
      }),
    ).toBeUndefined();
  });

  it("delivery resolver resolves a gateway-mode plugin with sendPoll for a poll send", async () => {
    const gatewayPollPlugin = {
      id: "alpha",
      outbound: { deliveryMode: "gateway", sendPoll: vi.fn() },
    };
    getLoadedChannelPluginMock.mockReturnValue(gatewayPollPlugin);
    const channelResolution = await importChannelResolution("delivery-gateway-poll");

    expect(
      channelResolution.resolveOutboundChannelPluginForDelivery({
        channel: "alpha",
        cfg: {} as never,
        operation: "poll",
      }),
    ).toBe(gatewayPollPlugin);
  });

  it("delivery resolver resolves a plugin sending text via message.send.text", async () => {
    const plugin = createSendingPlugin("alpha");
    getLoadedChannelPluginMock.mockReturnValue(plugin);
    const channelResolution = await importChannelResolution("delivery-message-text");

    expect(
      channelResolution.resolveOutboundChannelPluginForDelivery({
        channel: "alpha",
        cfg: {} as never,
        operation: "text",
      }),
    ).toBe(plugin);
  });

  it("delivery resolver resolves a plugin with only the legacy outbound text adapter", async () => {
    const plugin = { id: "alpha", outbound: { deliveryMode: "direct", sendText: vi.fn() } };
    getLoadedChannelPluginMock.mockReturnValue(plugin);
    const channelResolution = await importChannelResolution("delivery-legacy-outbound-text");

    expect(
      channelResolution.resolveOutboundChannelPluginForDelivery({
        channel: "alpha",
        cfg: {} as never,
        operation: "text",
      }),
    ).toBe(plugin);
  });

  it("delivery resolver resolves a poll-only non-gateway plugin for a poll send", async () => {
    // sendPoll() routes through the gateway gated only by outbound.sendPoll, so
    // a direct poll-only plugin is independently deliverable for a poll send.
    const plugin = { id: "alpha", outbound: { deliveryMode: "direct", sendPoll: vi.fn() } };
    getLoadedChannelPluginMock.mockReturnValue(plugin);
    const channelResolution = await importChannelResolution("delivery-poll-only");

    expect(
      channelResolution.resolveOutboundChannelPluginForDelivery({
        channel: "alpha",
        cfg: {} as never,
        operation: "poll",
      }),
    ).toBe(plugin);
  });

  it("delivery resolver text send skips a poll-only registration and returns a text-capable fallback", async () => {
    // A poll-only direct registration cannot deliver text (it would later fail
    // with "Outbound not configured"), so a text send must skip it and resolve
    // the text-capable runtime fallback instead of letting it win the lookup.
    const pollOnlyLoaded = { id: "alpha", outbound: { deliveryMode: "direct", sendPoll: vi.fn() } };
    const textCapable = createSendingPlugin("alpha");
    getLoadedChannelPluginMock.mockReturnValue(pollOnlyLoaded);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginRegistryMock.mockReturnValue({ channels: [{ plugin: textCapable }] });
    getActivePluginChannelRegistryMock.mockReturnValue({ channels: [{ plugin: textCapable }] });
    const channelResolution = await importChannelResolution("delivery-poll-only-not-shadow-text");

    expect(
      channelResolution.resolveOutboundChannelPluginForDelivery({
        channel: "alpha",
        cfg: {} as never,
        operation: "text",
      }),
    ).toBe(textCapable);
  });

  it("delivery resolver poll send skips a text-only registration and returns a poll-capable fallback", async () => {
    // A text-only direct registration cannot deliver a poll (sendPoll() would
    // throw "Unsupported poll channel"), so a poll send must skip it and resolve
    // the poll-capable runtime fallback instead of letting it win the lookup.
    const textOnlyLoaded = { id: "alpha", outbound: { deliveryMode: "direct", sendText: vi.fn() } };
    const pollCapable = { id: "alpha", outbound: { deliveryMode: "direct", sendPoll: vi.fn() } };
    getLoadedChannelPluginMock.mockReturnValue(textOnlyLoaded);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginRegistryMock.mockReturnValue({ channels: [{ plugin: pollCapable }] });
    getActivePluginChannelRegistryMock.mockReturnValue({ channels: [{ plugin: pollCapable }] });
    const channelResolution = await importChannelResolution("delivery-text-only-not-shadow-poll");

    expect(
      channelResolution.resolveOutboundChannelPluginForDelivery({
        channel: "alpha",
        cfg: {} as never,
        operation: "poll",
      }),
    ).toBe(pollCapable);
  });

  it("delivery resolver resolves an external channel from the active registry when the pin is stale without bootstrapping", async () => {
    // External id is not statically deliverable and is missing from the pinned
    // channel registry, but its send-capable runtime is live in the active
    // registry; the delivery resolver must find it without a second bootstrap.
    const plugin = { id: "external-channel", outbound: { sendText: vi.fn() } };
    isDeliverableMessageChannelMock.mockReturnValue(false);
    getLoadedChannelPluginMock.mockReturnValue(undefined);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: { id: "other-channel" } }],
    });
    getActivePluginRegistryMock.mockReturnValue({ channels: [{ plugin }] });
    const channelResolution = await importChannelResolution("delivery-external-active-registry");

    expect(
      channelResolution.resolveOutboundChannelPluginForDelivery({
        channel: "external-channel",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
        operation: "text",
      }),
    ).toBe(plugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("delivery resolver bootstraps an external channel exactly once before resolving its sender", async () => {
    // The external id only becomes resolvable after bootstrap; the shared
    // normalize path bootstraps it, and the `|| didBootstrap` guard must stop
    // the delivery resolver from bootstrapping a second time.
    const plugin = { id: "external-channel", outbound: { sendText: vi.fn() } };
    isDeliverableMessageChannelMock.mockReturnValue(false);
    getLoadedChannelPluginMock.mockReturnValue(undefined);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginChannelRegistryMock.mockReturnValue({ channels: [] });
    getActivePluginRegistryMock.mockImplementation(() =>
      resolveRuntimePluginRegistryMock.mock.calls.length > 0
        ? { channels: [{ plugin }] }
        : { channels: [] },
    );
    const channelResolution = await importChannelResolution("delivery-external-bootstrap-once");

    expect(
      channelResolution.resolveOutboundChannelPluginForDelivery({
        channel: "external-channel",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
        operation: "text",
      }),
    ).toBe(plugin);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });
});
