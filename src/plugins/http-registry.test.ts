import { describe, expect, it, vi } from "vitest";
import { registerPluginHttpRoute } from "./http-registry.js";
import { createEmptyPluginRegistry } from "./registry.js";

describe("registerPluginHttpRoute", () => {
  it("registers route and unregisters it", () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn();

    const unregister = registerPluginHttpRoute({
      path: "/plugins/demo",
      handler,
      registry,
    });

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.path).toBe("/plugins/demo");
    expect(registry.httpRoutes[0]?.handler).toBe(handler);

    unregister();
    expect(registry.httpRoutes).toHaveLength(0);
  });

  it("returns noop unregister when path is missing", () => {
    const registry = createEmptyPluginRegistry();
    const logs: string[] = [];
    const unregister = registerPluginHttpRoute({
      path: "",
      handler: vi.fn(),
      registry,
      accountId: "default",
      log: (msg) => logs.push(msg),
    });

    expect(registry.httpRoutes).toHaveLength(0);
    expect(logs).toEqual(['plugin: webhook path missing for account "default"']);
    expect(() => unregister()).not.toThrow();
  });

  it("replaces stale route on same path and keeps latest registration", () => {
    const registry = createEmptyPluginRegistry();
    const logs: string[] = [];
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();

    const unregisterFirst = registerPluginHttpRoute({
      path: "/plugins/synology",
      handler: firstHandler,
      registry,
      accountId: "default",
      pluginId: "synology-chat",
      log: (msg) => logs.push(msg),
    });

    const unregisterSecond = registerPluginHttpRoute({
      path: "/plugins/synology",
      handler: secondHandler,
      registry,
      accountId: "default",
      pluginId: "synology-chat",
      log: (msg) => logs.push(msg),
    });

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.handler).toBe(secondHandler);
    expect(logs).toContain(
      'plugin: replacing stale webhook path /plugins/synology for account "default" (synology-chat)',
    );

    // Old unregister must not remove the replacement route.
    unregisterFirst();
    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.handler).toBe(secondHandler);

    unregisterSecond();
    expect(registry.httpRoutes).toHaveLength(0);
  });
});
