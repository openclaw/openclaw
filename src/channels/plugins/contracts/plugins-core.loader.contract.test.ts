// Plugins core loader contract tests cover channel plugin loader setup and teardown behavior.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  createChannelTestPluginBase,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { loadChannelOutboundAdapter } from "../outbound/load.js";
import { createChannelRegistryLoader } from "../registry-loader.js";
import type { ChannelOutboundAdapter, ChannelPlugin } from "../types.public.js";

const loadChannelPlugin = createChannelRegistryLoader<ChannelPlugin>((entry) => entry.plugin);

const emptyRegistry = createTestRegistry([]);

const demoOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async () => ({ channel: "demo-loader", messageId: "m1" }),
  sendMedia: async () => ({ channel: "demo-loader", messageId: "m2" }),
};

const demoLoaderPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "demo-loader",
    label: "Demo Loader",
    config: { listAccountIds: () => [], resolveAccount: () => ({}) },
  }),
  outbound: demoOutbound,
};

const registryWithDemoLoader = createTestRegistry([
  { pluginId: "demo-loader", plugin: demoLoaderPlugin, source: "test" },
]);

const demoOutboundV2: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async () => ({ channel: "demo-loader", messageId: "m3" }),
  sendMedia: async () => ({ channel: "demo-loader", messageId: "m4" }),
};

const demoLoaderPluginV2 = createOutboundTestPlugin({
  id: "demo-loader",
  label: "Demo Loader",
  outbound: demoOutboundV2,
});

const registryWithDemoLoaderV2 = createTestRegistry([
  { pluginId: "demo-loader", plugin: demoLoaderPluginV2, source: "test-v2" },
]);

const demoNoOutboundPlugin = createChannelTestPluginBase({
  id: "demo-loader",
  label: "Demo Loader",
});

const registryWithDemoLoaderNoOutbound = createTestRegistry([
  { pluginId: "demo-loader", plugin: demoNoOutboundPlugin, source: "test-no-outbound" },
]);

describe("channel plugin loader", () => {
  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("prefers the registry scoped to a bootstrapped channel handler", async () => {
    setActivePluginRegistry(emptyRegistry);

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
    {
      name: "plugin",
      load: loadChannelPlugin,
      first: demoLoaderPlugin,
      second: demoLoaderPluginV2,
    },
    {
      name: "outbound",
      load: loadChannelOutboundAdapter,
      first: demoOutbound,
      second: demoOutboundV2,
    },
  ])("reads updated $name values when the registry changes", async ({ load, first, second }) => {
    setActivePluginRegistry(registryWithDemoLoader);
    expect(await load("demo-loader")).toBe(first);
    setActivePluginRegistry(registryWithDemoLoaderV2);
    expect(await load("demo-loader")).toBe(second);
  });

  it("returns undefined when the plugin has no outbound adapter", async () => {
    setActivePluginRegistry(registryWithDemoLoaderNoOutbound);
    expect(await loadChannelOutboundAdapter("demo-loader")).toBeUndefined();
  });
});
