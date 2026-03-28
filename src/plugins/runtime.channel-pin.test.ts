import { afterEach, describe, expect, it } from "vitest";
import { getChannelPlugin } from "../channels/plugins/registry.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  getActivePluginChannelRegistryVersion,
  getActivePluginRegistryVersion,
  getActivePluginChannelRegistry,
  pinActivePluginChannelRegistry,
  releasePinnedPluginChannelRegistry,
  requireActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "./runtime.js";

function createRegistryWithChannel(pluginId = "demo-channel") {
  const registry = createEmptyPluginRegistry();
  const plugin = { id: pluginId, meta: {} } as never;
  registry.channels = [{ plugin }] as never;
  return { registry, plugin };
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

function expectPinnedChannelRegistry(
  startupRegistry: ReturnType<typeof createEmptyPluginRegistry>,
  replacementRegistry: ReturnType<typeof createEmptyPluginRegistry>,
) {
  setActivePluginRegistry(startupRegistry);
  pinActivePluginChannelRegistry(startupRegistry);
  setActivePluginRegistry(replacementRegistry);
  expectActiveChannelRegistry(startupRegistry);
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
    setActivePluginRegistry(startup);
    if (pin) {
      pinActivePluginChannelRegistry(startup);
    }

    setActivePluginRegistry(replacement);
    expectActiveChannelRegistry(expectDuringPin ? startup : replacement);

    if (pin) {
      releasePinnedPluginChannelRegistry(releasePinnedRegistry ? startup : unrelated);
    }

    expectActiveChannelRegistry(expectAfterSwap === "second" ? replacement : startup);
  });

  it("requireActivePluginChannelRegistry creates a registry when none exists", () => {
    resetPluginRuntimeStateForTest();
    const registry = requireActivePluginChannelRegistry();
    expect(registry).toBeDefined();
    expect(registry.channels).toEqual([]);
  });

  it("resetPluginRuntimeStateForTest clears channel pin", () => {
    const { startup, replacement: fresh } = createRegistrySet();
    setActivePluginRegistry(startup);
    pinActivePluginChannelRegistry(startup);

    resetPluginRuntimeStateForTest();

    setActivePluginRegistry(fresh);
    expectActiveChannelRegistry(fresh);
  });
});
