import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
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
    startup.channels = [{ plugin: { id: "slack" } }] as never;
    setActivePluginRegistry(startup);
    pinActivePluginChannelRegistry(startup);

    // A subsequent registry swap (e.g., config-schema load) must not evict channels.
    const replacement = createEmptyPluginRegistry();
    setActivePluginRegistry(replacement);

    expect(getActivePluginChannelRegistry()).toBe(startup);
    expect(getActivePluginChannelRegistry()!.channels).toHaveLength(1);
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
