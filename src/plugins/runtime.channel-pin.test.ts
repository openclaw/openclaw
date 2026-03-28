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

describe("channel registry pinning", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("returns the active registry when not pinned", () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    expect(getActivePluginChannelRegistry()).toBe(registry);
  });

  it("preserves pinned channel registry across setActivePluginRegistry calls", () => {
    const { registry: startup } = createRegistryWithChannel();
    setActivePluginRegistry(startup);
    pinActivePluginChannelRegistry(startup);

    // A subsequent registry swap (e.g., config-schema load) must not evict channels.
    const replacement = createEmptyPluginRegistry();
    setActivePluginRegistry(replacement);

    expect(getActivePluginChannelRegistry()).toBe(startup);
    expect(getActivePluginChannelRegistry()!.channels).toHaveLength(1);
  });

  it("re-pin invalidates cached channel lookups", () => {
    const { registry: setup, plugin: setupPlugin } = createRegistryWithChannel();
    setActivePluginRegistry(setup);
    pinActivePluginChannelRegistry(setup);

    expect(getChannelPlugin("demo-channel")).toBe(setupPlugin);

    const { registry: full, plugin: fullPlugin } = createRegistryWithChannel();
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
    const startup = createEmptyPluginRegistry();
    setActivePluginRegistry(startup);
    const unrelated = createEmptyPluginRegistry();
    const replacement = createEmptyPluginRegistry();
    if (pin) {
      pinActivePluginChannelRegistry(startup);
    }

    setActivePluginRegistry(replacement);
    expect(getActivePluginChannelRegistry()).toBe(expectDuringPin ? startup : replacement);

    if (pin) {
      releasePinnedPluginChannelRegistry(releasePinnedRegistry ? startup : unrelated);
    }

    expect(getActivePluginChannelRegistry()).toBe(
      expectAfterSwap === "second" ? replacement : startup,
    );
  });

  it("requireActivePluginChannelRegistry creates a registry when none exists", () => {
    resetPluginRuntimeStateForTest();
    const registry = requireActivePluginChannelRegistry();
    expect(registry).toBeDefined();
    expect(registry.channels).toEqual([]);
  });

  it("resetPluginRuntimeStateForTest clears channel pin", () => {
    const startup = createEmptyPluginRegistry();
    setActivePluginRegistry(startup);
    pinActivePluginChannelRegistry(startup);

    resetPluginRuntimeStateForTest();

    const fresh = createEmptyPluginRegistry();
    setActivePluginRegistry(fresh);
    expect(getActivePluginChannelRegistry()).toBe(fresh);
  });
});
