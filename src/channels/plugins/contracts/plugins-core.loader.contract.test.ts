import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { loadChannelOutboundAdapter } from "../outbound/load.js";
import { createChannelRegistryLoader } from "../registry-loader.js";
import type { ChannelOutboundAdapter, ChannelPlugin } from "../types.public.js";

const loadChannelPlugin = createChannelRegistryLoader((entry) => entry.plugin);

const emptyRegistry = createTestRegistry([]);

function makeOutbound(textId: string, mediaId: string): ChannelOutboundAdapter {
  return {
    deliveryMode: "direct",
    sendText: async () => ({ channel: "demo-loader", messageId: textId }),
    sendMedia: async () => ({ channel: "demo-loader", messageId: mediaId }),
  };
}
const demoNoOutboundPlugin = createChannelTestPluginBase({
  id: "demo-loader",
  label: "Demo Loader",
  config: { listAccountIds: () => [], resolveAccount: () => ({}) },
});
const demoOutbound = makeOutbound("m1", "m2");
const demoOutboundV2 = makeOutbound("m3", "m4");
const demoLoaderPlugin: ChannelPlugin = { ...demoNoOutboundPlugin, outbound: demoOutbound };
const demoLoaderPluginV2: ChannelPlugin = { ...demoNoOutboundPlugin, outbound: demoOutboundV2 };
const registryFor = (plugin: ChannelPlugin) =>
  createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]);
const registryWithDemoLoader = registryFor(demoLoaderPlugin);
const registryWithDemoLoaderV2 = registryFor(demoLoaderPluginV2);
const registryWithDemoLoaderNoOutbound = registryFor(demoNoOutboundPlugin);

describe("channel plugin loader", () => {
  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("prefers the registry scoped to a bootstrapped channel handler", async () => {
    const loaded = await withPluginRuntimeRegistryScope(registryWithDemoLoader, () =>
      loadChannelOutboundAdapter("demo-loader"),
    );

    expect(loaded).toBe(demoOutbound);
  });

  it("does not escape the scoped registry when the channel is omitted", async () => {
    setActivePluginRegistry(registryWithDemoLoader);

    const loaded = await withPluginRuntimeRegistryScope(emptyRegistry, () =>
      loadChannelOutboundAdapter("demo-loader"),
    );

    expect(loaded).toBeUndefined();
  });

  it("preserves a missing adapter from the scoped channel registration", async () => {
    setActivePluginRegistry(registryWithDemoLoader);

    const loaded = await withPluginRuntimeRegistryScope(registryWithDemoLoaderNoOutbound, () =>
      loadChannelOutboundAdapter("demo-loader"),
    );

    expect(loaded).toBeUndefined();
  });

  it.each([
    ["plugin", loadChannelPlugin, demoLoaderPlugin, demoLoaderPluginV2],
    ["outbound", loadChannelOutboundAdapter, demoOutbound, demoOutboundV2],
  ] as const)(
    "reads updated %s values when the registry changes",
    async (_name, load, first, second) => {
      setActivePluginRegistry(registryWithDemoLoader);
      expect(await load("demo-loader")).toBe(first);
      setActivePluginRegistry(registryWithDemoLoaderV2);
      expect(await load("demo-loader")).toBe(second);
    },
  );

  it("returns undefined when the plugin has no outbound adapter", async () => {
    setActivePluginRegistry(registryWithDemoLoaderNoOutbound);
    expect(await loadChannelOutboundAdapter("demo-loader")).toBeUndefined();
  });
});
