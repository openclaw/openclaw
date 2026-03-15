import { describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import {
  addExtensionHostCliRegistration,
  addExtensionHostHttpRoute,
  addExtensionHostProviderRegistration,
  addExtensionHostServiceRegistration,
  addExtensionHostToolRegistration,
  getExtensionHostGatewayHandlers,
  hasExtensionHostRuntimeEntries,
  listExtensionHostCliRegistrations,
  listExtensionHostHttpRoutes,
  listExtensionHostProviderRegistrations,
  listExtensionHostServiceRegistrations,
  listExtensionHostToolRegistrations,
  removeExtensionHostHttpRoute,
  replaceExtensionHostHttpRoute,
  setExtensionHostGatewayHandler,
} from "./runtime-registry.js";

describe("extension host runtime registry accessors", () => {
  it("detects runtime entries across non-tool surfaces", () => {
    const providerRegistry = createEmptyPluginRegistry();
    addExtensionHostProviderRegistration(providerRegistry, {
      pluginId: "provider-demo",
      source: "test",
      provider: {
        id: "provider-demo",
        label: "Provider Demo",
        auth: [],
      },
    });
    expect(hasExtensionHostRuntimeEntries(providerRegistry)).toBe(true);

    const routeRegistry = createEmptyPluginRegistry();
    addExtensionHostHttpRoute(routeRegistry, {
      path: "/plugins/demo",
      handler: vi.fn(),
      auth: "plugin",
      match: "exact",
      pluginId: "route-demo",
      source: "test",
    });
    expect(hasExtensionHostRuntimeEntries(routeRegistry)).toBe(true);

    const gatewayRegistry = createEmptyPluginRegistry();
    setExtensionHostGatewayHandler({
      registry: gatewayRegistry,
      method: "demo.echo",
      handler: vi.fn(),
    });
    expect(hasExtensionHostRuntimeEntries(gatewayRegistry)).toBe(true);

    const cliRegistry = createEmptyPluginRegistry();
    addExtensionHostCliRegistration(cliRegistry, {
      pluginId: "cli-demo",
      source: "test",
      commands: ["demo"],
      register: () => undefined,
    });
    expect(hasExtensionHostRuntimeEntries(cliRegistry)).toBe(true);

    const serviceRegistry = createEmptyPluginRegistry();
    addExtensionHostServiceRegistration(serviceRegistry, {
      pluginId: "svc-demo",
      source: "test",
      service: {
        id: "svc-demo",
        start: () => undefined,
      },
    });
    expect(hasExtensionHostRuntimeEntries(serviceRegistry)).toBe(true);
  });

  it("returns stable empty views for missing registries", () => {
    expect(hasExtensionHostRuntimeEntries(null)).toBe(false);
    expect(listExtensionHostProviderRegistrations(null)).toEqual([]);
    expect(listExtensionHostToolRegistrations(null)).toEqual([]);
    expect(listExtensionHostServiceRegistrations(null)).toEqual([]);
    expect(listExtensionHostCliRegistrations(null)).toEqual([]);
    expect(listExtensionHostHttpRoutes(null)).toEqual([]);
    expect(getExtensionHostGatewayHandlers(null)).toEqual({});
  });

  it("projects existing registry collections without copying them", () => {
    const registry = createEmptyPluginRegistry();
    addExtensionHostToolRegistration(registry, {
      pluginId: "tool-demo",
      optional: false,
      source: "test",
      names: ["tool_demo"],
      factory: () => ({
        name: "tool_demo",
        description: "tool demo",
        parameters: { type: "object", properties: {} },
        async execute() {
          return { content: [{ type: "text", text: "ok" }] };
        },
      }),
    });
    addExtensionHostProviderRegistration(registry, {
      pluginId: "provider-demo",
      source: "test",
      provider: {
        id: "provider-demo",
        label: "Provider Demo",
        auth: [],
      },
    });
    addExtensionHostServiceRegistration(registry, {
      pluginId: "svc-demo",
      source: "test",
      service: {
        id: "svc-demo",
        start: () => undefined,
      },
    });
    addExtensionHostCliRegistration(registry, {
      pluginId: "cli-demo",
      source: "test",
      commands: ["demo"],
      register: () => undefined,
    });
    addExtensionHostHttpRoute(registry, {
      path: "/plugins/demo",
      handler: vi.fn(),
      auth: "plugin",
      match: "exact",
      pluginId: "route-demo",
      source: "test",
    });
    const handler = vi.fn();
    setExtensionHostGatewayHandler({
      registry,
      method: "demo.echo",
      handler,
    });

    expect(listExtensionHostToolRegistrations(registry)).toEqual(registry.tools);
    expect(listExtensionHostProviderRegistrations(registry)).toEqual(registry.providers);
    expect(listExtensionHostServiceRegistrations(registry)).toEqual(registry.services);
    expect(listExtensionHostCliRegistrations(registry)).toEqual(registry.cliRegistrars);
    expect(listExtensionHostHttpRoutes(registry)).toEqual(registry.httpRoutes);
    expect(getExtensionHostGatewayHandlers(registry)).toEqual(registry.gatewayHandlers);
    expect(getExtensionHostGatewayHandlers(registry)["demo.echo"]).toBe(handler);
  });

  it("keeps legacy route and gateway mirrors synchronized with host-owned state", () => {
    const registry = createEmptyPluginRegistry();
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();
    const entry = {
      path: "/plugins/demo",
      handler: firstHandler,
      auth: "plugin" as const,
      match: "exact" as const,
      pluginId: "route-demo",
      source: "test",
    };

    addExtensionHostHttpRoute(registry, entry);
    setExtensionHostGatewayHandler({
      registry,
      method: "demo.echo",
      handler: firstHandler,
    });
    replaceExtensionHostHttpRoute({
      registry,
      index: 0,
      entry: { ...entry, handler: secondHandler },
    });
    removeExtensionHostHttpRoute(registry, entry);

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.handler).toBe(secondHandler);
    expect(getExtensionHostGatewayHandlers(registry)).toEqual(registry.gatewayHandlers);
  });

  it("keeps legacy CLI and service mirrors synchronized with host-owned state", () => {
    const registry = createEmptyPluginRegistry();
    const service = {
      id: "svc-demo",
      start: () => undefined,
    };
    const register = () => undefined;

    addExtensionHostServiceRegistration(registry, {
      pluginId: "svc-demo",
      source: "test",
      service,
    });
    addExtensionHostCliRegistration(registry, {
      pluginId: "cli-demo",
      source: "test",
      commands: ["demo"],
      register,
    });

    expect(listExtensionHostServiceRegistrations(registry)).toEqual(registry.services);
    expect(listExtensionHostCliRegistrations(registry)).toEqual(registry.cliRegistrars);
    expect(registry.services[0]?.service).toBe(service);
    expect(registry.cliRegistrars[0]?.register).toBe(register);
  });

  it("keeps legacy tool and provider mirrors synchronized with host-owned state", () => {
    const registry = createEmptyPluginRegistry();
    const factory = (() => ({}) as never) as never;
    const provider = {
      id: "provider-demo",
      label: "Provider Demo",
      auth: [],
    };

    addExtensionHostToolRegistration(registry, {
      pluginId: "tool-demo",
      optional: false,
      source: "test",
      names: ["tool_demo"],
      factory,
    });
    addExtensionHostProviderRegistration(registry, {
      pluginId: "provider-demo",
      source: "test",
      provider,
    });

    expect(listExtensionHostToolRegistrations(registry)).toEqual(registry.tools);
    expect(listExtensionHostProviderRegistrations(registry)).toEqual(registry.providers);
    expect(registry.tools[0]?.factory).toBe(factory);
    expect(registry.providers[0]?.provider).toBe(provider);
  });
});
