import { describe, expect, it, vi } from "vitest";
import { registerPluginHttpRoute } from "./http-registry.js";
import { createEmptyPluginRegistry } from "./registry.js";

describe("registerPluginHttpRoute", () => {
  it("registers route and unregisters it", () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn();

    const unregister = registerPluginHttpRoute({
      path: "/demo",
      handler,
      registry,
    });

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.path).toBe("/demo");
    expect(registry.httpRoutes[0]?.handler).toBe(handler);
    expect(registry.httpRoutes[0]?.kind).toBe("default");

    unregister();
    expect(registry.httpRoutes).toHaveLength(0);
  });

  it("allows explicit webhook-kind routes", () => {
    const registry = createEmptyPluginRegistry();
    const unregister = registerPluginHttpRoute({
      path: "/demo-hook",
      handler: vi.fn(),
      kind: "webhook",
      registry,
    });

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.kind).toBe("webhook");

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

  it("reuses shared same-plugin webhook routes until the last unregister", () => {
    const registry = createEmptyPluginRegistry();
    const logs: string[] = [];
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();

    const unregisterFirst = registerPluginHttpRoute({
      path: "/synology-webhook",
      handler: firstHandler,
      registry,
      accountId: "default",
      pluginId: "synology-chat",
      kind: "webhook",
      log: (msg) => logs.push(msg),
    });

    const unregisterSecond = registerPluginHttpRoute({
      path: "/synology-webhook",
      handler: secondHandler,
      registry,
      accountId: "default",
      pluginId: "synology-chat",
      kind: "webhook",
      log: (msg) => logs.push(msg),
    });

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.handler).toBe(firstHandler);
    expect(registry.httpRoutes[0]?.kind).toBe("webhook");
    expect(logs).toContain(
      'plugin: reusing shared webhook path /synology-webhook for account "default" (synology-chat)',
    );

    unregisterFirst();
    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.handler).toBe(firstHandler);

    unregisterSecond();
    expect(registry.httpRoutes).toHaveLength(0);
  });

  it("rejects webhook routes on core-owned paths", () => {
    const registry = createEmptyPluginRegistry();
    const logs: string[] = [];
    const unregister = registerPluginHttpRoute({
      path: "/chat",
      handler: vi.fn(),
      registry,
      pluginId: "bluebubbles",
      kind: "webhook",
      log: (msg) => logs.push(msg),
    });

    expect(registry.httpRoutes).toHaveLength(0);
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "bluebubbles",
        message: "http webhook route conflicts with core path: /chat",
      }),
    );
    expect(logs).toContain(
      "plugin: refusing webhook path /chat because it conflicts with a core route",
    );
    expect(() => unregister()).not.toThrow();
  });

  it("refuses to replace a route registered by a different plugin", () => {
    const registry = createEmptyPluginRegistry();
    registerPluginHttpRoute({
      path: "/shared-hook",
      handler: vi.fn(),
      registry,
      pluginId: "first",
      kind: "webhook",
    });

    const logs: string[] = [];
    const unregister = registerPluginHttpRoute({
      path: "/shared-hook",
      handler: vi.fn(),
      registry,
      pluginId: "second",
      kind: "webhook",
      log: (msg) => logs.push(msg),
    });

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.pluginId).toBe("first");
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "second",
        message: "http route already registered: /shared-hook",
      }),
    );
    expect(logs).toContain("plugin: refusing duplicate route /shared-hook");
    expect(() => unregister()).not.toThrow();
  });
});
