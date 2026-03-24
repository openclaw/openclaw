import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "./registry.js";
import {
  getActivePluginChannelRegistry,
  pinActivePluginChannelRegistry,
  pinActivePluginHttpRouteRegistry,
  releasePinnedPluginChannelRegistry,
  releasePinnedPluginHttpRouteRegistry,
  resetPluginRuntimeStateForTest,
  resolveActivePluginHttpRouteRegistry,
  setActivePluginRegistry,
} from "./runtime.js";

describe("plugin runtime route registry", () => {
  afterEach(() => {
    releasePinnedPluginChannelRegistry();
    releasePinnedPluginHttpRouteRegistry();
    resetPluginRuntimeStateForTest();
  });

  it("keeps the pinned route registry when the active plugin registry changes", () => {
    const startupRegistry = createEmptyPluginRegistry();
    const laterRegistry = createEmptyPluginRegistry();

    setActivePluginRegistry(startupRegistry);
    pinActivePluginHttpRouteRegistry(startupRegistry);
    setActivePluginRegistry(laterRegistry);

    expect(resolveActivePluginHttpRouteRegistry(laterRegistry)).toBe(startupRegistry);
  });

  it("falls back to the provided registry when the pinned route registry has no routes", () => {
    const startupRegistry = createEmptyPluginRegistry();
    const explicitRegistry = createEmptyPluginRegistry();
    explicitRegistry.httpRoutes.push({
      path: "/demo",
      auth: "plugin",
      match: "exact",
      handler: () => true,
      pluginId: "demo",
      source: "test",
    });

    setActivePluginRegistry(startupRegistry);
    pinActivePluginHttpRouteRegistry(startupRegistry);

    expect(resolveActivePluginHttpRouteRegistry(explicitRegistry)).toBe(explicitRegistry);
  });

  it("prefers the pinned route registry when it already owns routes", () => {
    const startupRegistry = createEmptyPluginRegistry();
    const explicitRegistry = createEmptyPluginRegistry();
    startupRegistry.httpRoutes.push({
      path: "/bluebubbles-webhook",
      auth: "plugin",
      match: "exact",
      handler: () => true,
      pluginId: "bluebubbles",
      source: "test",
    });
    explicitRegistry.httpRoutes.push({
      path: "/plugins/diffs",
      auth: "plugin",
      match: "prefix",
      handler: () => true,
      pluginId: "diffs",
      source: "test",
    });

    setActivePluginRegistry(startupRegistry);
    pinActivePluginHttpRouteRegistry(startupRegistry);

    expect(resolveActivePluginHttpRouteRegistry(explicitRegistry)).toBe(startupRegistry);
  });
});

describe("plugin runtime channel registry", () => {
  afterEach(() => {
    releasePinnedPluginChannelRegistry();
    releasePinnedPluginHttpRouteRegistry();
    resetPluginRuntimeStateForTest();
  });

  it("keeps the pinned channel registry when the active plugin registry changes", () => {
    const startupRegistry = createEmptyPluginRegistry();
    const laterRegistry = createEmptyPluginRegistry();

    setActivePluginRegistry(startupRegistry);
    pinActivePluginChannelRegistry(startupRegistry);
    setActivePluginRegistry(laterRegistry);

    expect(getActivePluginChannelRegistry()).toBe(startupRegistry);
  });

  it("releases the pinned channel registry back to the active registry", () => {
    const startupRegistry = createEmptyPluginRegistry();
    const laterRegistry = createEmptyPluginRegistry();

    setActivePluginRegistry(startupRegistry);
    pinActivePluginChannelRegistry(startupRegistry);
    setActivePluginRegistry(laterRegistry);
    releasePinnedPluginChannelRegistry(startupRegistry);

    expect(getActivePluginChannelRegistry()).toBe(laterRegistry);
  });
});
