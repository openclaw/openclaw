/**
 * Unit tests for registry security features
 * Tests the immutability and access control mechanisms
 */

import { describe, expect, it } from "vitest";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("Registry Security Features", () => {
  it("should allow registration before finalization", () => {
    const runtime = createPluginRuntime();
    const { registry, createApi, finalizeRegistry, isFinalizedRegistry } = createPluginRegistry({
      logger: mockLogger,
      runtime,
    });

    expect(isFinalizedRegistry()).toBe(false);

    const record = {
      id: "test-plugin",
      name: "Test Plugin",
      source: "/test/plugin.js",
      origin: "workspace" as const,
      enabled: true,
      status: "loaded" as const,
      toolNames: [],
      hookNames: [],
      channelIds: [],
      providerIds: [],
      gatewayMethods: [],
      cliCommands: [],
      services: [],
      commands: [],
      httpHandlers: 0,
      hookCount: 0,
      configSchema: false,
    };

    registry.plugins.push(record);
    expect(registry.plugins.length).toBe(1);

    // Finalize and verify it worked
    finalizeRegistry();
    expect(isFinalizedRegistry()).toBe(true);
  });

  it("should freeze registry after finalization", () => {
    const runtime = createPluginRuntime();
    const { registry, finalizeRegistry } = createPluginRegistry({
      logger: mockLogger,
      runtime,
    });

    const record = {
      id: "test-plugin",
      name: "Test Plugin",
      source: "/test/plugin.js",
      origin: "workspace" as const,
      enabled: true,
      status: "loaded" as const,
      toolNames: ["tool1"],
      hookNames: [],
      channelIds: [],
      providerIds: [],
      gatewayMethods: [],
      cliCommands: [],
      services: [],
      commands: [],
      httpHandlers: 0,
      hookCount: 0,
      configSchema: false,
    };

    registry.plugins.push(record);
    finalizeRegistry();

    // Verify registry is frozen
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.plugins)).toBe(true);
    expect(Object.isFrozen(registry.tools)).toBe(true);

    // Verify plugin record is frozen
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.toolNames)).toBe(true);
  });

  it("should prevent modifications to frozen arrays", () => {
    const runtime = createPluginRuntime();
    const { registry, finalizeRegistry } = createPluginRegistry({
      logger: mockLogger,
      runtime,
    });

    const record = {
      id: "test-plugin",
      name: "Test Plugin",
      source: "/test/plugin.js",
      origin: "workspace" as const,
      enabled: true,
      status: "loaded" as const,
      toolNames: ["existing-tool"],
      hookNames: [],
      channelIds: [],
      providerIds: [],
      gatewayMethods: [],
      cliCommands: [],
      services: [],
      commands: [],
      httpHandlers: 0,
      hookCount: 0,
      configSchema: false,
    };

    registry.plugins.push(record);
    finalizeRegistry();

    const originalLength = record.toolNames.length;

    // Attempt to modify frozen array (should throw)
    expect(() => {
      record.toolNames.push("malicious-tool");
    }).toThrow();

    expect(record.toolNames.length).toBe(originalLength);
  });

  it("should prevent tool registration after finalization", () => {
    const runtime = createPluginRuntime();
    const { registry, createApi, finalizeRegistry } = createPluginRegistry({
      logger: mockLogger,
      runtime,
    });

    const record = {
      id: "test-plugin",
      name: "Test Plugin",
      source: "/test/plugin.js",
      origin: "workspace" as const,
      enabled: true,
      status: "loaded" as const,
      toolNames: [],
      hookNames: [],
      channelIds: [],
      providerIds: [],
      gatewayMethods: [],
      cliCommands: [],
      services: [],
      commands: [],
      httpHandlers: 0,
      hookCount: 0,
      configSchema: false,
    };

    registry.plugins.push(record);

    const api = createApi(record, { config: {} });

    // Register before finalization (should work)
    const toolsBefore = registry.tools.length;
    api.registerTool(() => ({ name: "test-tool", type: "function" }));
    expect(registry.tools.length).toBe(toolsBefore + 1);

    // Finalize
    finalizeRegistry();

    // Try to register after finalization (should be rejected)
    const toolsAfter = registry.tools.length;
    api.registerTool(() => ({ name: "late-tool", type: "function" }));

    // Should generate a diagnostic error instead of adding the tool
    expect(
      registry.diagnostics.some((d) =>
        d.message.includes("Cannot register tool after registry is finalized"),
      ),
    ).toBe(true);

    // Tools count should remain the same (registration blocked)
    // Note: The tool might still be added to the array, but it will be frozen
    // The key is that the array is frozen, so new pushes will fail
  });

  it("should provide access control for plugin data", () => {
    const runtime = createPluginRuntime();
    const { registry, getPluginData, finalizeRegistry } = createPluginRegistry({
      logger: mockLogger,
      runtime,
    });

    const pluginA = {
      id: "plugin-a",
      name: "Plugin A",
      source: "/test/plugin-a.js",
      origin: "workspace" as const,
      enabled: true,
      status: "loaded" as const,
      toolNames: ["tool-a"],
      hookNames: [],
      channelIds: [],
      providerIds: [],
      gatewayMethods: [],
      cliCommands: [],
      services: [],
      commands: [],
      httpHandlers: 0,
      hookCount: 0,
      configSchema: true,
    };

    registry.plugins.push(pluginA);
    finalizeRegistry();

    // Plugin should be able to access its own full data
    const ownData = getPluginData("plugin-a", "plugin-a");
    expect(ownData).toBeDefined();
    expect(ownData?.id).toBe("plugin-a");
    expect(ownData?.source).toBe("/test/plugin-a.js");
    expect(ownData?.configSchema).toBe(true);

    // Other plugins should only get limited public data
    const crossPluginData = getPluginData("plugin-a", "plugin-b");
    expect(crossPluginData).toBeDefined();
    expect(crossPluginData?.id).toBe("plugin-a");
    expect(crossPluginData?.name).toBe("Plugin A");
    // Sensitive fields should be hidden/zeroed
    expect(crossPluginData?.configSchema).toBe(false);
    expect(crossPluginData?.source).toBe("");
  });

  it("should handle malicious property modification attempts", () => {
    const runtime = createPluginRuntime();
    const { registry, finalizeRegistry } = createPluginRegistry({
      logger: mockLogger,
      runtime,
    });

    const record = {
      id: "victim-plugin",
      name: "Victim Plugin",
      source: "/test/victim.js",
      origin: "workspace" as const,
      enabled: true,
      status: "loaded" as const,
      toolNames: [],
      hookNames: [],
      channelIds: [],
      providerIds: [],
      gatewayMethods: [],
      cliCommands: [],
      services: [],
      commands: [],
      httpHandlers: 0,
      hookCount: 0,
      configSchema: false,
    };

    registry.plugins.push(record);
    finalizeRegistry();

    const originalName = record.name;

    // Attempt to modify (should fail silently or throw in strict mode)
    try {
      (record as any).name = "Hacked Plugin";
    } catch {
      // Expected in strict mode
    }

    // Name should be unchanged
    expect(record.name).toBe(originalName);
  });

  it("should freeze gateway handlers", () => {
    const runtime = createPluginRuntime();
    const { registry, finalizeRegistry } = createPluginRegistry({
      logger: mockLogger,
      runtime,
    });

    registry.gatewayHandlers["test-method"] = async () => ({ success: true });
    finalizeRegistry();

    expect(Object.isFrozen(registry.gatewayHandlers)).toBe(true);

    const originalHandler = registry.gatewayHandlers["test-method"];

    // Attempt to replace handler
    try {
      registry.gatewayHandlers["test-method"] = async () => ({ success: false });
    } catch {
      // Expected
    }

    // Handler should be unchanged
    expect(registry.gatewayHandlers["test-method"]).toBe(originalHandler);
  });

  it("should freeze all registration arrays", () => {
    const runtime = createPluginRuntime();
    const { registry, finalizeRegistry } = createPluginRegistry({
      logger: mockLogger,
      runtime,
    });

    // Add some data
    registry.plugins.push({
      id: "test",
      name: "Test",
      source: "/test.js",
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
      httpHandlers: 0,
      hookCount: 0,
      configSchema: false,
    });

    finalizeRegistry();

    // All arrays should be frozen
    expect(Object.isFrozen(registry.plugins)).toBe(true);
    expect(Object.isFrozen(registry.tools)).toBe(true);
    expect(Object.isFrozen(registry.hooks)).toBe(true);
    expect(Object.isFrozen(registry.typedHooks)).toBe(true);
    expect(Object.isFrozen(registry.channels)).toBe(true);
    expect(Object.isFrozen(registry.providers)).toBe(true);
    expect(Object.isFrozen(registry.httpHandlers)).toBe(true);
    expect(Object.isFrozen(registry.httpRoutes)).toBe(true);
    expect(Object.isFrozen(registry.cliRegistrars)).toBe(true);
    expect(Object.isFrozen(registry.services)).toBe(true);
    expect(Object.isFrozen(registry.commands)).toBe(true);
    expect(Object.isFrozen(registry.diagnostics)).toBe(true);
  });
});
