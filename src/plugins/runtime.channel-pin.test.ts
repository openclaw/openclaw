import { afterEach, describe, expect, it } from "vitest";
import { loadChannelOutboundAdapter } from "../channels/plugins/outbound/load.js";
import { getChannelPlugin } from "../channels/plugins/registry.js";
import { resolveProviderRuntimePluginHandle } from "./provider-hook-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  getActivePluginChannelRegistryVersion,
  getActivePluginGatewayRuntimeRegistry,
  getActivePluginGatewayRuntimeRegistryVersion,
  getActivePluginGatewayRuntimeRegistryWorkspaceDir,
  getActivePluginGatewayRuntimeSubagentMode,
  getActivePluginRegistryVersion,
  getActivePluginChannelRegistry,
  pinActivePluginGatewayRuntimeRegistry,
  pinActivePluginChannelRegistry,
  releasePinnedPluginGatewayRuntimeRegistry,
  releasePinnedPluginChannelRegistry,
  requireActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "./runtime.js";
import type { ProviderPlugin } from "./types.js";

function createRegistryWithChannel(pluginId = "demo-channel") {
  const registry = createEmptyPluginRegistry();
  const plugin = { id: pluginId, meta: {} } as never;
  registry.channels = [{ plugin }] as never;
  return { registry, plugin };
}

function createRegistryWithProvider(pluginId = "demo-provider", providerId = "demo") {
  const registry = createEmptyPluginRegistry();
  const provider = { id: providerId, label: providerId } as ProviderPlugin;
  registry.providers = [{ pluginId, provider, source: "test" }] as never;
  return { registry, provider };
}

function createChannelRegistryPair(pluginId = "demo-channel") {
  return {
    first: createRegistryWithChannel(pluginId),
    second: createRegistryWithChannel(pluginId),
  };
}

function createRegistrySet() {
  return {
    startup: createEmptyPluginRegistry(),
    replacement: createEmptyPluginRegistry(),
    unrelated: createEmptyPluginRegistry(),
  };
}

function expectActiveChannelRegistry(registry: ReturnType<typeof createEmptyPluginRegistry>) {
  expect(getActivePluginChannelRegistry()).toBe(registry);
}

function expectActiveGatewayRuntimeRegistry(
  registry: ReturnType<typeof createEmptyPluginRegistry>,
) {
  expect(getActivePluginGatewayRuntimeRegistry()).toBe(registry);
}

function expectPinnedChannelRegistry(
  startupRegistry: ReturnType<typeof createEmptyPluginRegistry>,
  replacementRegistry: ReturnType<typeof createEmptyPluginRegistry>,
) {
  setActivePluginRegistry(startupRegistry);
  pinActivePluginChannelRegistry(startupRegistry);
  setActivePluginRegistry(replacementRegistry);
  expectActiveChannelRegistry(startupRegistry);
}

function expectResetClearsPinnedChannelRegistry(params: {
  startupRegistry: ReturnType<typeof createEmptyPluginRegistry>;
  freshRegistry: ReturnType<typeof createEmptyPluginRegistry>;
}) {
  setActivePluginRegistry(params.startupRegistry);
  pinActivePluginChannelRegistry(params.startupRegistry);

  resetPluginRuntimeStateForTest();

  setActivePluginRegistry(params.freshRegistry);
  expectActiveChannelRegistry(params.freshRegistry);
}

function expectChannelRegistrySwap(params: {
  startupRegistry: ReturnType<typeof createEmptyPluginRegistry>;
  replacementRegistry: ReturnType<typeof createEmptyPluginRegistry>;
  pin?: boolean;
  releaseRegistry?: ReturnType<typeof createEmptyPluginRegistry>;
  expectedDuringSwap: ReturnType<typeof createEmptyPluginRegistry>;
  expectedAfterRelease: ReturnType<typeof createEmptyPluginRegistry>;
}) {
  setActivePluginRegistry(params.startupRegistry);
  if (params.pin) {
    pinActivePluginChannelRegistry(params.startupRegistry);
  }

  setActivePluginRegistry(params.replacementRegistry);
  expectActiveChannelRegistry(params.expectedDuringSwap);

  if (params.pin && params.releaseRegistry) {
    releasePinnedPluginChannelRegistry(params.releaseRegistry);
  }

  expectActiveChannelRegistry(params.expectedAfterRelease);
}

describe("channel registry pinning", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("returns the active registry when not pinned", () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    expectActiveChannelRegistry(registry);
  });

  it("preserves pinned channel registry across setActivePluginRegistry calls", () => {
    const { registry: startup } = createRegistryWithChannel();
    // A subsequent registry swap (e.g., config-schema load) must not evict channels.
    const replacement = createEmptyPluginRegistry();
    expectPinnedChannelRegistry(startup, replacement);
    expect(getActivePluginChannelRegistry()!.channels).toHaveLength(1);
  });

  it("re-pin invalidates cached channel lookups", () => {
    const { first, second } = createChannelRegistryPair();
    const { registry: setup, plugin: setupPlugin } = first;
    setActivePluginRegistry(setup);
    pinActivePluginChannelRegistry(setup);

    expect(getChannelPlugin("demo-channel")).toBe(setupPlugin);

    const { registry: full, plugin: fullPlugin } = second;
    setActivePluginRegistry(full);

    expect(getChannelPlugin("demo-channel")).toBe(setupPlugin);

    const activeVersionBeforeRepin = getActivePluginRegistryVersion();
    const channelVersionBeforeRepin = getActivePluginChannelRegistryVersion();
    pinActivePluginChannelRegistry(full);

    expect(getActivePluginRegistryVersion()).toBe(activeVersionBeforeRepin);
    expect(getActivePluginChannelRegistryVersion()).toBe(channelVersionBeforeRepin + 1);
    expect(getChannelPlugin("demo-channel")).toBe(fullPlugin);
  });

  it.each([
    {
      name: "updates channel registry on swap when not pinned",
      pin: false,
      releasePinnedRegistry: false,
      expectDuringPin: false,
      expectAfterSwap: "second",
    },
    {
      name: "release restores live-tracking behavior",
      pin: true,
      releasePinnedRegistry: true,
      expectDuringPin: true,
      expectAfterSwap: "second",
    },
    {
      name: "release is a no-op when the pinned registry does not match",
      pin: true,
      releasePinnedRegistry: false,
      expectDuringPin: true,
      expectAfterSwap: "first",
    },
  ] as const)("$name", ({ pin, releasePinnedRegistry, expectDuringPin, expectAfterSwap }) => {
    const { startup, replacement, unrelated } = createRegistrySet();
    expectChannelRegistrySwap({
      startupRegistry: startup,
      replacementRegistry: replacement,
      ...(pin ? { pin: true } : {}),
      ...(pin ? { releaseRegistry: releasePinnedRegistry ? startup : unrelated } : {}),
      expectedDuringSwap: expectDuringPin ? startup : replacement,
      expectedAfterRelease: expectAfterSwap === "second" ? replacement : startup,
    });
  });

  it("requireActivePluginChannelRegistry creates a registry when none exists", () => {
    resetPluginRuntimeStateForTest();
    const registry = requireActivePluginChannelRegistry();
    expect(registry).toMatchObject({ channels: [] });
  });

  it("resetPluginRuntimeStateForTest clears channel pin", () => {
    const { startup, replacement: fresh } = createRegistrySet();
    expectResetClearsPinnedChannelRegistry({
      startupRegistry: startup,
      freshRegistry: fresh,
    });
  });

  it("loadChannelOutboundAdapter resolves from pinned registry after active registry replacement", async () => {
    const outboundAdapter = { send: async () => ({ messageId: "1" }) };
    const startup = createEmptyPluginRegistry();
    startup.channels = [
      {
        pluginId: "telegram",
        plugin: { id: "telegram", meta: {}, outbound: outboundAdapter },
        source: "test",
      },
    ] as never;
    setActivePluginRegistry(startup);
    pinActivePluginChannelRegistry(startup);

    // Simulate a post-boot registry replacement (e.g. config-schema load, plugin status query).
    const replacement = createEmptyPluginRegistry();
    setActivePluginRegistry(replacement);

    // The outbound loader must still find the telegram adapter from the pinned registry.
    const adapter = await loadChannelOutboundAdapter("telegram");
    expect(adapter).toBe(outboundAdapter);
  });
});

describe("gateway runtime registry pinning", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("preserves pinned gateway runtime registry across active registry churn", () => {
    const { startup, replacement } = createRegistrySet();
    setActivePluginRegistry(startup, "startup-key", "gateway-bindable", "/tmp/workspace");
    pinActivePluginGatewayRuntimeRegistry(startup);

    setActivePluginRegistry(replacement, "replacement-key", "default", "/tmp/other");

    expectActiveGatewayRuntimeRegistry(startup);
    expect(getActivePluginGatewayRuntimeRegistryWorkspaceDir()).toBe("/tmp/workspace");
    expect(getActivePluginGatewayRuntimeSubagentMode()).toBe("gateway-bindable");
  });

  it("release restores live-tracking behavior", () => {
    const { startup, replacement } = createRegistrySet();
    setActivePluginRegistry(startup, "startup-key", "gateway-bindable", "/tmp/workspace");
    pinActivePluginGatewayRuntimeRegistry(startup);
    setActivePluginRegistry(replacement, "replacement-key", "default", "/tmp/other");

    const gatewayVersionBeforeRelease = getActivePluginGatewayRuntimeRegistryVersion();
    releasePinnedPluginGatewayRuntimeRegistry(startup);

    expect(getActivePluginGatewayRuntimeRegistryVersion()).toBe(gatewayVersionBeforeRelease + 1);
    expectActiveGatewayRuntimeRegistry(replacement);
    expect(getActivePluginGatewayRuntimeRegistryWorkspaceDir()).toBe("/tmp/other");
    expect(getActivePluginGatewayRuntimeSubagentMode()).toBe("default");
  });

  it("resetPluginRuntimeStateForTest clears gateway runtime pin", () => {
    const { startup, replacement } = createRegistrySet();
    setActivePluginRegistry(startup, "startup-key", "gateway-bindable", "/tmp/workspace");
    pinActivePluginGatewayRuntimeRegistry(startup);

    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(replacement);

    expectActiveGatewayRuntimeRegistry(replacement);
    expect(getActivePluginGatewayRuntimeRegistryWorkspaceDir()).toBeUndefined();
    expect(getActivePluginGatewayRuntimeSubagentMode()).toBe("default");
  });

  it("provider runtime handles resolve from pinned gateway runtime registry", () => {
    const { registry: startup, provider } = createRegistryWithProvider();
    const replacement = createEmptyPluginRegistry();
    setActivePluginRegistry(startup, "startup-key", "gateway-bindable", "/tmp/workspace");
    pinActivePluginGatewayRuntimeRegistry(startup);

    setActivePluginRegistry(replacement, "replacement-key", "default", "/tmp/workspace");

    const handle = resolveProviderRuntimePluginHandle({
      provider: "demo",
      workspaceDir: "/tmp/workspace",
    });
    expect(handle.plugin?.id).toBe(provider.id);
    expect((handle.plugin as { pluginId?: string } | undefined)?.pluginId).toBe("demo-provider");
  });
});
