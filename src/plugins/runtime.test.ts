import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "./registry.js";
import {
  getActivePluginHttpRouteRegistryVersion,
  getActivePluginRegistryVersion,
  getActivePluginRegistry,
  pinActivePluginHttpRouteRegistry,
  releasePinnedPluginHttpRouteRegistry,
  resetPluginRuntimeStateForTest,
  resolveActivePluginHttpRouteRegistry,
  setActivePluginRegistry,
} from "./runtime.js";

function createRegistryWithRoute(path: string) {
  const registry = createEmptyPluginRegistry();
  registry.httpRoutes.push({
    path,
    auth: "plugin",
    match: path === "/plugins/diffs" ? "prefix" : "exact",
    handler: () => true,
    pluginId: path === "/plugins/diffs" ? "diffs" : "demo",
    source: "test",
  });
  return registry;
}

describe("plugin runtime route registry", () => {
  afterEach(() => {
    releasePinnedPluginHttpRouteRegistry();
    resetPluginRuntimeStateForTest();
  });

  it("stays empty until a caller explicitly installs or requires a registry", () => {
    resetPluginRuntimeStateForTest();

    expect(getActivePluginRegistry()).toBeNull();
  });

  it("keeps the pinned route registry when the active plugin registry changes", () => {
    const startupRegistry = createEmptyPluginRegistry();
    const laterRegistry = createEmptyPluginRegistry();

    setActivePluginRegistry(startupRegistry);
    pinActivePluginHttpRouteRegistry(startupRegistry);
    setActivePluginRegistry(laterRegistry);

    expect(resolveActivePluginHttpRouteRegistry(laterRegistry)).toBe(startupRegistry);
  });

  it("tracks route registry repins separately from the active registry version", () => {
    const startupRegistry = createEmptyPluginRegistry();
    const laterRegistry = createEmptyPluginRegistry();
    const repinnedRegistry = createEmptyPluginRegistry();

    setActivePluginRegistry(startupRegistry);
    pinActivePluginHttpRouteRegistry(laterRegistry);

    const activeVersionBeforeRepin = getActivePluginRegistryVersion();
    const routeVersionBeforeRepin = getActivePluginHttpRouteRegistryVersion();

    pinActivePluginHttpRouteRegistry(repinnedRegistry);

    expect(getActivePluginRegistryVersion()).toBe(activeVersionBeforeRepin);
    expect(getActivePluginHttpRouteRegistryVersion()).toBe(routeVersionBeforeRepin + 1);
  });

  it.each([
    {
      name: "falls back to the provided registry when the pinned route registry has no routes",
      pinnedRegistry: createEmptyPluginRegistry(),
      explicitRegistry: createRegistryWithRoute("/demo"),
      expected: "explicit",
    },
    {
      name: "prefers the pinned route registry when it already owns routes",
      pinnedRegistry: createRegistryWithRoute("/bluebubbles-webhook"),
      explicitRegistry: createRegistryWithRoute("/plugins/diffs"),
      expected: "pinned",
    },
  ] as const)("$name", ({ pinnedRegistry, explicitRegistry, expected }) => {
    setActivePluginRegistry(pinnedRegistry);
    pinActivePluginHttpRouteRegistry(pinnedRegistry);

    expect(resolveActivePluginHttpRouteRegistry(explicitRegistry)).toBe(
      expected === "pinned" ? pinnedRegistry : explicitRegistry,
    );
  });
});
