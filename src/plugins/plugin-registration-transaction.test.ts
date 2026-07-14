import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMemoryCapabilityRegistration,
  registerMemoryCapability,
} from "./memory-state.test-fixtures.js";
import {
  createPluginRegistrationTransaction,
  type PluginProcessGlobalState,
  restorePluginProcessGlobalState,
  snapshotPluginProcessGlobalState,
} from "./plugin-registration-transaction.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginRecord } from "./status.test-helpers.js";

describe("plugin registration transaction", () => {
  let initialProcessGlobalState: PluginProcessGlobalState;

  beforeEach(() => {
    initialProcessGlobalState = snapshotPluginProcessGlobalState();
  });

  afterEach(() => {
    restorePluginProcessGlobalState(initialProcessGlobalState);
  });

  it("rolls back registry writes and restores prior process-global capability state", () => {
    const registry = createEmptyPluginRegistry();
    const activePromptBuilder = () => ["active"];
    const failedResolver = () => "failed";
    const rollbackGlobalSideEffects = vi.fn();
    registerMemoryCapability("active-memory", { promptBuilder: activePromptBuilder });

    const transaction = createPluginRegistrationTransaction({
      registry,
      rollbackGlobalSideEffects,
    });
    registry.hostedMediaResolvers.push({
      pluginId: "failed-plugin",
      resolver: failedResolver,
      source: "failed-plugin",
    });
    registry.gatewayHandlers.failed = async () => {};
    registerMemoryCapability("failed-memory", { promptBuilder: () => ["failed"] });

    transaction.rollback();

    expect(rollbackGlobalSideEffects).toHaveBeenCalledOnce();
    expect(registry.hostedMediaResolvers).toStrictEqual([]);
    expect(registry.gatewayHandlers).toStrictEqual({});
    expect(getMemoryCapabilityRegistration()).toEqual({
      pluginId: "active-memory",
      capability: { promptBuilder: activePromptBuilder },
    });
  });

  it("restores the current record after a failed registration", () => {
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: "failed-plugin" });
    const toolNames = record.toolNames;

    const transaction = createPluginRegistrationTransaction({ registry, currentRecord: record });
    record.httpRoutes += 1;
    record.hookCount += 1;
    record.toolNames.push("failed-tool");
    record.contextEngineIds = ["failed-engine"];
    record.error = "failed registration";

    transaction.rollback();

    expect(registry.plugins).toEqual([]);
    expect(record.httpRoutes).toBe(0);
    expect(record.hookCount).toBe(0);
    expect(record.toolNames).toEqual([]);
    expect(record.toolNames).not.toBe(toolNames);
    expect(record.contextEngineIds).toEqual([]);
    expect(record).not.toHaveProperty("error");
  });

  it("restores in-place mutations to existing registry entries", () => {
    const registry = createEmptyPluginRegistry();
    const rawHandler = async () => undefined;
    registry.agentToolResultMiddlewares.push({
      pluginId: "existing-plugin",
      handler: rawHandler,
      rawHandler,
      runtimes: ["openclaw"],
    });
    const originalEntry = registry.agentToolResultMiddlewares[0];

    const transaction = createPluginRegistrationTransaction({ registry });
    originalEntry.runtimes.push("codex");

    transaction.rollback();

    expect(registry.agentToolResultMiddlewares).toHaveLength(1);
    expect(registry.agentToolResultMiddlewares[0]).not.toBe(originalEntry);
    expect(registry.agentToolResultMiddlewares[0]?.rawHandler).toBe(rawHandler);
    expect(registry.agentToolResultMiddlewares[0]?.runtimes).toEqual(["openclaw"]);
  });

  it("keeps snapshot registry writes while restoring globals for non-activating commits", () => {
    const registry = createEmptyPluginRegistry();
    const activePromptBuilder = () => ["active"];
    const snapshotResolver = () => "snapshot";
    registerMemoryCapability("active-memory", { promptBuilder: activePromptBuilder });

    const transaction = createPluginRegistrationTransaction({ registry });
    registry.hostedMediaResolvers.push({
      pluginId: "snapshot-plugin",
      resolver: snapshotResolver,
      source: "snapshot-plugin",
    });
    registerMemoryCapability("snapshot-memory", { promptBuilder: () => ["snapshot"] });

    transaction.commit({ activate: false });

    expect(registry.hostedMediaResolvers).toEqual([
      {
        pluginId: "snapshot-plugin",
        resolver: snapshotResolver,
        source: "snapshot-plugin",
      },
    ]);
    expect(getMemoryCapabilityRegistration()).toEqual({
      pluginId: "active-memory",
      capability: { promptBuilder: activePromptBuilder },
    });
  });
});
