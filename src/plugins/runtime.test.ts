import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "./registry.js";
import {
  getPluginProvidersByCapability,
  pinActivePluginHttpRouteRegistry,
  releasePinnedPluginHttpRouteRegistry,
  resetPluginRuntimeStateForTest,
  resolveActivePluginHttpRouteRegistry,
  setActivePluginRegistry,
} from "./runtime.js";
import type { PluginProviderEntry } from "./runtime.js";

describe("plugin runtime route registry", () => {
  afterEach(() => {
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

describe("getPluginProvidersByCapability", () => {
  afterEach(() => {
    releasePinnedPluginHttpRouteRegistry();
    resetPluginRuntimeStateForTest();
  });

  it("returns providers with array capabilities matching the filter", () => {
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "test-plugin",
      pluginName: "Test Plugin",
      source: "test",
      provider: {
        id: "test-provider",
        label: "Test Provider",
        auth: [],
        routingCapabilities: ["audio", "image"],
        transcribeAudio: async () => ({ text: "transcribed" }),
      },
    });
    setActivePluginRegistry(registry);

    const result = getPluginProvidersByCapability(
      (cap): cap is "audio" | "image" => cap === "audio" || cap === "image",
      (p: PluginProviderEntry) => (p.id ? { id: p.id } : undefined),
    );

    expect(result["test-provider"]).toBeDefined();
    expect(result["test-provider"].id).toBe("test-provider");
  });

  it("handles undefined routingCapabilities without crashing", () => {
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "test-plugin",
      pluginName: "Test Plugin",
      source: "test",
      provider: {
        id: "test-provider",
        label: "Test Provider",
        auth: [],
        transcribeAudio: async () => ({ text: "transcribed" }),
      },
    });
    setActivePluginRegistry(registry);

    expect(() => {
      getPluginProvidersByCapability(
        (cap): cap is "audio" => cap === "audio",
        (p: PluginProviderEntry) => (p.id ? { id: p.id } : undefined),
      );
    }).not.toThrow();
  });

  it("handles null routingCapabilities without crashing", () => {
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "test-plugin",
      pluginName: "Test Plugin",
      source: "test",
      provider: {
        id: "test-provider",
        label: "Test Provider",
        auth: [],
        routingCapabilities: null,
        transcribeAudio: async () => ({ text: "transcribed" }),
      },
    } as never);
    setActivePluginRegistry(registry);

    expect(() => {
      getPluginProvidersByCapability(
        (cap): cap is "audio" => cap === "audio",
        (p: PluginProviderEntry) => (p.id ? { id: p.id } : undefined),
      );
    }).not.toThrow();
  });

  it("handles object-shaped routingCapabilities without crashing", () => {
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "test-plugin",
      pluginName: "Test Plugin",
      source: "test",
      provider: {
        id: "test-provider",
        label: "Test Provider",
        auth: [],
        routingCapabilities: { providerFamily: "openai" },
        transcribeAudio: async () => ({ text: "transcribed" }),
      },
    } as never);
    setActivePluginRegistry(registry);

    expect(() => {
      getPluginProvidersByCapability(
        (cap): cap is "audio" => cap === "audio",
        (p: PluginProviderEntry) => (p.id ? { id: p.id } : undefined),
      );
    }).not.toThrow();
  });

  it("skips providers with non-matching capabilities", () => {
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "test-plugin",
      pluginName: "Test Plugin",
      source: "test",
      provider: {
        id: "test-provider",
        label: "Test Provider",
        auth: [],
        routingCapabilities: ["video"],
        describeVideo: async () => ({ text: "video description" }),
      },
    });
    setActivePluginRegistry(registry);

    const result = getPluginProvidersByCapability(
      (cap): cap is "audio" => cap === "audio",
      (p: PluginProviderEntry) => (p.id ? { id: p.id } : undefined),
    );

    expect(result["test-provider"]).toBeUndefined();
  });

  it("returns empty object when no registry is set", () => {
    resetPluginRuntimeStateForTest();

    const result = getPluginProvidersByCapability(
      (cap): cap is "audio" => cap === "audio",
      (p: PluginProviderEntry) => (p.id ? { id: p.id } : undefined),
    );

    expect(result).toEqual({});
  });
});
