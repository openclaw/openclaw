import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  getActivePluginHookRegistry,
  getActivePluginHookRegistryVersion,
  getActivePluginRegistryVersion,
  pinActivePluginHookRegistry,
  releasePinnedPluginHookRegistry,
  requireActivePluginHookRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "./runtime.js";

function createRegistrySet() {
  return {
    startup: createEmptyPluginRegistry(),
    replacement: createEmptyPluginRegistry(),
    unrelated: createEmptyPluginRegistry(),
  };
}

describe("hook registry pinning", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("returns the active registry when not pinned", () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    expect(getActivePluginHookRegistry()).toBe(registry);
  });

  it("preserves pinned hook registry across setActivePluginRegistry calls", () => {
    const { startup, replacement } = createRegistrySet();
    setActivePluginRegistry(startup);
    pinActivePluginHookRegistry(startup);

    setActivePluginRegistry(replacement);

    expect(getActivePluginHookRegistry()).toBe(startup);
  });

  it("tracks hook registry repins separately from the active registry version", () => {
    const { startup, replacement } = createRegistrySet();
    setActivePluginRegistry(startup);
    pinActivePluginHookRegistry(startup);

    const activeVersionBeforeRepin = getActivePluginRegistryVersion();
    const hookVersionBeforeRepin = getActivePluginHookRegistryVersion();

    pinActivePluginHookRegistry(replacement);

    expect(getActivePluginRegistryVersion()).toBe(activeVersionBeforeRepin);
    expect(getActivePluginHookRegistryVersion()).toBe(hookVersionBeforeRepin + 1);
    expect(getActivePluginHookRegistry()).toBe(replacement);
  });

  it("release restores live-tracking behavior", () => {
    const { startup, replacement } = createRegistrySet();
    setActivePluginRegistry(startup);
    pinActivePluginHookRegistry(startup);

    setActivePluginRegistry(replacement);
    expect(getActivePluginHookRegistry()).toBe(startup);

    releasePinnedPluginHookRegistry(startup);
    expect(getActivePluginHookRegistry()).toBe(replacement);
  });

  it("unqualified release clears a re-pinned hook registry", () => {
    const { startup, replacement } = createRegistrySet();
    setActivePluginRegistry(startup);
    pinActivePluginHookRegistry(startup);
    pinActivePluginHookRegistry(replacement);

    releasePinnedPluginHookRegistry();

    expect(getActivePluginHookRegistry()).toBe(startup);
  });

  it("release is a no-op when the pinned registry does not match", () => {
    const { startup, replacement, unrelated } = createRegistrySet();
    setActivePluginRegistry(startup);
    pinActivePluginHookRegistry(startup);

    setActivePluginRegistry(replacement);
    releasePinnedPluginHookRegistry(unrelated);

    expect(getActivePluginHookRegistry()).toBe(startup);
  });

  it("requireActivePluginHookRegistry creates a registry when none exists", () => {
    resetPluginRuntimeStateForTest();

    const registry = requireActivePluginHookRegistry();

    expect(registry).toBeDefined();
    expect(registry.hooks).toEqual([]);
  });

  it("resetPluginRuntimeStateForTest clears hook pin", () => {
    const { startup, replacement } = createRegistrySet();
    setActivePluginRegistry(startup);
    pinActivePluginHookRegistry(startup);

    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(replacement);

    expect(getActivePluginHookRegistry()).toBe(replacement);
  });
});
