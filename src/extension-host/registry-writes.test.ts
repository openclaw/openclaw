import { describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry, type PluginRecord } from "../plugins/registry.js";
import {
  addExtensionChannelRegistration,
  addExtensionCliRegistration,
  addExtensionCommandRegistration,
  addExtensionContextEngineRegistration,
  addExtensionGatewayMethodRegistration,
  addExtensionLegacyHookRegistration,
  addExtensionHttpRouteRegistration,
  addExtensionProviderRegistration,
  addExtensionServiceRegistration,
  addExtensionToolRegistration,
  addExtensionTypedHookRegistration,
} from "./registry-writes.js";

function createRecord(): PluginRecord {
  return {
    id: "demo",
    name: "Demo",
    source: "/plugins/demo.ts",
    origin: "workspace",
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    providerIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
  };
}

describe("extension host registry writes", () => {
  it("writes tool registrations through the host helper", () => {
    const registry = createEmptyPluginRegistry();
    const record = createRecord();

    addExtensionToolRegistration({
      registry,
      record,
      names: ["tool-a"],
      entry: {
        pluginId: record.id,
        factory: (() => ({}) as never) as never,
        names: ["tool-a"],
        optional: false,
        source: record.source,
      },
    });

    expect(record.toolNames).toEqual(["tool-a"]);
    expect(registry.tools).toHaveLength(1);
  });

  it("writes cli, service, and command registrations through host helpers", () => {
    const registry = createEmptyPluginRegistry();
    const record = createRecord();

    addExtensionCliRegistration({
      registry,
      record,
      commands: ["demo"],
      entry: {
        pluginId: record.id,
        register: (() => {}) as never,
        commands: ["demo"],
        source: record.source,
      },
    });
    addExtensionServiceRegistration({
      registry,
      record,
      serviceId: "svc",
      entry: {
        pluginId: record.id,
        service: { id: "svc", start: async () => {}, stop: async () => {} } as never,
        source: record.source,
      },
    });
    addExtensionCommandRegistration({
      registry,
      record,
      commandName: "cmd",
      entry: {
        pluginId: record.id,
        command: { name: "cmd", description: "demo", run: async () => {} } as never,
        source: record.source,
      },
    });

    expect(record.cliCommands).toEqual(["demo"]);
    expect(record.services).toEqual(["svc"]);
    expect(record.commands).toEqual(["cmd"]);
    expect(registry.cliRegistrars).toHaveLength(1);
    expect(registry.services).toHaveLength(1);
    expect(registry.commands).toHaveLength(1);
  });

  it("writes gateway, http, channel, and provider registrations through host helpers", () => {
    const registry = createEmptyPluginRegistry();
    const record = createRecord();

    addExtensionGatewayMethodRegistration({
      registry,
      record,
      method: "demo.method",
      handler: (() => {}) as never,
    });
    addExtensionHttpRouteRegistration({
      registry,
      record,
      action: "append",
      entry: {
        pluginId: record.id,
        path: "/demo",
        handler: (() => {}) as never,
        auth: "optional",
        match: "exact",
        source: record.source,
      },
    });
    addExtensionChannelRegistration({
      registry,
      record,
      channelId: "demo-channel",
      entry: {
        pluginId: record.id,
        plugin: {} as never,
        source: record.source,
      },
    });
    addExtensionProviderRegistration({
      registry,
      record,
      providerId: "demo-provider",
      entry: {
        pluginId: record.id,
        provider: {} as never,
        source: record.source,
      },
    });

    expect(record.gatewayMethods).toEqual(["demo.method"]);
    expect(record.httpRoutes).toBe(1);
    expect(record.channelIds).toEqual(["demo-channel"]);
    expect(record.providerIds).toEqual(["demo-provider"]);
    expect(registry.gatewayHandlers["demo.method"]).toBeTypeOf("function");
    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.channels).toHaveLength(1);
    expect(registry.providers).toHaveLength(1);
    expect(registry.providers[0]?.pluginId).toBe("demo");
  });

  it("writes legacy hooks, typed hooks, and context engines through host helpers", () => {
    const registry = createEmptyPluginRegistry();
    const record = createRecord();
    const registerEngine = vi.fn();

    addExtensionLegacyHookRegistration({
      registry,
      record,
      hookName: "before_send",
      events: ["before_send"],
      entry: {
        pluginId: record.id,
        entry: {} as never,
        events: ["before_send"],
        source: record.source,
        handler: (() => {}) as never,
      },
    });
    addExtensionTypedHookRegistration({
      registry,
      record,
      entry: {
        pluginId: record.id,
        hookName: "before_send" as never,
        handler: (() => {}) as never,
        priority: 0,
        source: record.source,
      } as never,
    });
    addExtensionContextEngineRegistration({
      entry: {
        engineId: "context-demo",
        factory: (() => ({}) as never) as never,
      },
      registerEngine,
    });

    expect(record.hookNames).toEqual(["before_send"]);
    expect(record.hookCount).toBe(1);
    expect(registry.hooks).toHaveLength(1);
    expect(registry.typedHooks).toHaveLength(1);
    expect(registerEngine).toHaveBeenCalledWith("context-demo", expect.any(Function));
  });
});
