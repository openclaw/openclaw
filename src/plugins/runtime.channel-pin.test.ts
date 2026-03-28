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
    const startup = createEmptyPluginRegistry();
    startup.channels = [{ plugin: { id: "demo-channel" } }] as never;
    setActivePluginRegistry(startup);
    pinActivePluginChannelRegistry(startup);

    // A subsequent registry swap (e.g., config-schema load) must not evict channels.
    const replacement = createEmptyPluginRegistry();
    setActivePluginRegistry(replacement);

    expect(getActivePluginChannelRegistry()).toBe(startup);
    expect(getActivePluginChannelRegistry()!.channels).toHaveLength(1);
  });

  it("re-pin invalidates cached channel lookups", () => {
    const setup = createEmptyPluginRegistry();
    const setupPlugin = { id: "demo-channel", meta: {} } as never;
    setup.channels = [{ plugin: setupPlugin }] as never;
    setActivePluginRegistry(setup);
    pinActivePluginChannelRegistry(setup);

    expect(getChannelPlugin("demo-channel")).toBe(setupPlugin);

    const full = createEmptyPluginRegistry();
    const fullPlugin = { id: "demo-channel", meta: {} } as never;
    full.channels = [{ plugin: fullPlugin }] as never;
    setActivePluginRegistry(full);

    expect(getChannelPlugin("demo-channel")).toBe(setupPlugin);

    const activeVersionBeforeRepin = getActivePluginRegistryVersion();
    const channelVersionBeforeRepin = getActivePluginChannelRegistryVersion();
    pinActivePluginChannelRegistry(full);

    expect(getActivePluginRegistryVersion()).toBe(activeVersionBeforeRepin);
    expect(getActivePluginChannelRegistryVersion()).toBe(channelVersionBeforeRepin + 1);
    expect(getChannelPlugin("demo-channel")).toBe(fullPlugin);
  });

  it("updates channel registry on swap when not pinned", () => {
    const first = createEmptyPluginRegistry();
    setActivePluginRegistry(first);
    expect(getActivePluginChannelRegistry()).toBe(first);

    const second = createEmptyPluginRegistry();
    setActivePluginRegistry(second);
    expect(getActivePluginChannelRegistry()).toBe(second);
  });

  it("release restores live-tracking behavior", () => {
    const startup = createEmptyPluginRegistry();
    setActivePluginRegistry(startup);
    pinActivePluginChannelRegistry(startup);

    const replacement = createEmptyPluginRegistry();
    setActivePluginRegistry(replacement);
    expect(getActivePluginChannelRegistry()).toBe(startup);

    releasePinnedPluginChannelRegistry(startup);
    // After release, the channel registry should follow the active registry.
    expect(getActivePluginChannelRegistry()).toBe(replacement);
  });

  it("release is a no-op when the pinned registry does not match", () => {
    const startup = createEmptyPluginRegistry();
    setActivePluginRegistry(startup);
    pinActivePluginChannelRegistry(startup);

    const unrelated = createEmptyPluginRegistry();
    releasePinnedPluginChannelRegistry(unrelated);

    // Pin is still held — unrelated release was ignored.
    const replacement = createEmptyPluginRegistry();
    setActivePluginRegistry(replacement);
    expect(getActivePluginChannelRegistry()).toBe(startup);
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
