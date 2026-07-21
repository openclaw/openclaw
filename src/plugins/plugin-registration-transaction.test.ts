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

  it("rollback restores original array element values after in-place mutation", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({
      id: "test-plugin",
      name: "Test Plugin",
      enabled: true,
      status: "loaded" as const,
      source: "test",
      origin: "external" as const,
      toolNames: [],
      hookNames: [],
      channelIds: [],
      cliBackendIds: [],
      providerIds: [],
      embeddingProviderIds: [],
      speechProviderIds: [],
      realtimeTranscriptionProviderIds: [],
      realtimeVoiceProviderIds: [],
      mediaUnderstandingProviderIds: [],
      transcriptSourceProviderIds: [],
      imageGenerationProviderIds: [],
      videoGenerationProviderIds: [],
      musicGenerationProviderIds: [],
      webFetchProviderIds: [],
      webSearchProviderIds: [],
      migrationProviderIds: [],
      memoryEmbeddingProviderIds: [],
      agentHarnessIds: [],
      cliCommands: [],
      services: [],
      gatewayDiscoveryServiceIds: [],
      commands: [],
      httpRoutes: 0,
      hookCount: 0,
      configSchema: false,
    });

    const transaction = createPluginRegistrationTransaction({ registry });

    // Mutate the plugin record in-place - the snapshot should be unaffected
    registry.plugins[0].enabled = false;
    registry.plugins[0].status = "disabled";

    transaction.rollback();

    expect(registry.plugins[0].enabled).toBe(true);
    expect(registry.plugins[0].status).toBe("loaded");
  });
});
