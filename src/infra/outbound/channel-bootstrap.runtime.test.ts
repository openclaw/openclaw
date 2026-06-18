// Covers lazy outbound channel bootstrap, retry guards, auto-enable config, and
// send-capable active registry short-circuiting.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  pinActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";

const loaderMocks = vi.hoisted(() => ({
  resolveRuntimePluginRegistry: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
}));

vi.mock("../../plugins/loader.js", () => ({
  resolveRuntimePluginRegistry: loaderMocks.resolveRuntimePluginRegistry,
  loadOpenClawPlugins: loaderMocks.loadOpenClawPlugins,
}));

const { bootstrapOutboundChannelPlugin, resetOutboundChannelBootstrapStateForTests } =
  await import("./channel-bootstrap.runtime.js");

const discordConfig = {
  channels: {
    discord: {},
  },
} satisfies OpenClawConfig;

describe("bootstrapOutboundChannelPlugin", () => {
  afterEach(() => {
    loaderMocks.resolveRuntimePluginRegistry.mockReset();
    loaderMocks.loadOpenClawPlugins.mockReset();
    resetOutboundChannelBootstrapStateForTests();
    resetPluginRuntimeStateForTest();
  });

  it("bootstraps when the selected channel registry has only a setup shell", () => {
    const registry = createEmptyPluginRegistry();
    registry.channels = [
      {
        pluginId: "discord",
        plugin: { id: "discord", meta: {} },
        source: "setup",
      },
    ] as never;
    setActivePluginRegistry(registry);
    pinActivePluginChannelRegistry(registry);

    bootstrapOutboundChannelPlugin({
      channel: "discord",
      cfg: discordConfig,
    });

    expect(loaderMocks.resolveRuntimePluginRegistry).toHaveBeenCalledTimes(1);
  });

  it("skips bootstrap when the selected channel entry can already send", () => {
    const registry = createEmptyPluginRegistry();
    registry.channels = [
      {
        pluginId: "discord",
        plugin: {
          id: "discord",
          meta: {},
          outbound: { sendText: async () => ({ messageId: "1" }) },
        },
        source: "runtime",
      },
    ] as never;
    setActivePluginRegistry(registry);
    pinActivePluginChannelRegistry(registry);

    bootstrapOutboundChannelPlugin({
      channel: "discord",
      cfg: discordConfig,
    });

    expect(loaderMocks.resolveRuntimePluginRegistry).not.toHaveBeenCalled();
  });

  it("skips bootstrap when the active replacement registry can send for a pinned setup shell", () => {
    const setup = createEmptyPluginRegistry();
    setup.channels = [
      {
        pluginId: "discord",
        plugin: { id: "discord", meta: {} },
        source: "setup",
      },
    ] as never;
    const runtime = createEmptyPluginRegistry();
    runtime.channels = [
      {
        pluginId: "discord",
        plugin: {
          id: "discord",
          meta: {},
          outbound: { sendText: async () => ({ messageId: "1" }) },
        },
        source: "runtime",
      },
    ] as never;
    setActivePluginRegistry(setup);
    pinActivePluginChannelRegistry(setup);
    setActivePluginRegistry(runtime);

    bootstrapOutboundChannelPlugin({
      channel: "discord",
      cfg: discordConfig,
    });

    expect(loaderMocks.resolveRuntimePluginRegistry).not.toHaveBeenCalled();
  });

  it("skips bootstrap when the active replacement registry has a message send surface", () => {
    const setup = createEmptyPluginRegistry();
    setup.channels = [
      {
        pluginId: "discord",
        plugin: { id: "discord", meta: {} },
        source: "setup",
      },
    ] as never;
    const runtime = createEmptyPluginRegistry();
    runtime.channels = [
      {
        pluginId: "discord",
        plugin: {
          id: "discord",
          meta: {},
          message: { send: { text: async () => ({ messageId: "1" }) } },
        },
        source: "runtime",
      },
    ] as never;
    setActivePluginRegistry(setup);
    pinActivePluginChannelRegistry(setup);
    setActivePluginRegistry(runtime);

    bootstrapOutboundChannelPlugin({
      channel: "discord",
      cfg: discordConfig,
    });

    expect(loaderMocks.resolveRuntimePluginRegistry).not.toHaveBeenCalled();
  });

  it("retries when bootstrap returns without making the channel send-capable", () => {
    const registry = createEmptyPluginRegistry();
    registry.channels = [
      {
        pluginId: "discord",
        plugin: { id: "discord", meta: {} },
        source: "setup",
      },
    ] as never;
    setActivePluginRegistry(registry);
    pinActivePluginChannelRegistry(registry);

    bootstrapOutboundChannelPlugin({
      channel: "discord",
      cfg: discordConfig,
    });
    bootstrapOutboundChannelPlugin({
      channel: "discord",
      cfg: discordConfig,
    });

    expect(loaderMocks.resolveRuntimePluginRegistry).toHaveBeenCalledTimes(2);
  });

  it("falls back to loadOpenClawPlugins when the cached registry lacks the external channel (#78754)", () => {
    // Simulate an existing registry that does not include the npm-installed
    // external channel plugin.  resolveRuntimePluginRegistry returns the
    // cached registry, but the channel is still not send-capable.  The
    // bootstrap should then call loadOpenClawPlugins directly to force a
    // fresh plugin discovery that includes install records.
    const registry = createEmptyPluginRegistry();
    registry.channels = [] as never;
    setActivePluginRegistry(registry);
    pinActivePluginChannelRegistry(registry);

    // First call (resolveRuntimePluginRegistry) returns the cached registry
    // without the channel.  Second call (loadOpenClawPlugins) also returns
    // a registry (the channel might still not be found, but the call must
    // happen).
    loaderMocks.loadOpenClawPlugins.mockReturnValue(registry);

    bootstrapOutboundChannelPlugin({
      channel: "openclaw-weixin",
      cfg: { channels: { "openclaw-weixin": {} } } as OpenClawConfig,
    });

    expect(loaderMocks.resolveRuntimePluginRegistry).toHaveBeenCalledTimes(1);
    expect(loaderMocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
  });

  it("skips loadOpenClawPlugins fallback when resolveRuntimePluginRegistry resolves the channel", () => {
    const registry = createEmptyPluginRegistry();
    registry.channels = [
      {
        pluginId: "openclaw-weixin",
        plugin: {
          id: "openclaw-weixin",
          meta: {},
          outbound: { sendText: async () => ({ messageId: "1" }) },
        },
        source: "runtime",
      },
    ] as never;
    setActivePluginRegistry(registry);
    pinActivePluginChannelRegistry(registry);

    bootstrapOutboundChannelPlugin({
      channel: "openclaw-weixin",
      cfg: { channels: { "openclaw-weixin": {} } } as OpenClawConfig,
    });

    expect(loaderMocks.resolveRuntimePluginRegistry).not.toHaveBeenCalled();
    expect(loaderMocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });
});
