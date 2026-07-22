import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearActivatedPluginRuntimeState } from "./loader-shared.js";
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
import {
  getSessionDiscussionProvider,
  registerSessionDiscussionProvider,
  type SessionDiscussionProvider,
} from "./session-discussion-registry.js";

function discussionProvider(id: string): SessionDiscussionProvider {
  return {
    id,
    info: vi.fn().mockResolvedValue({ state: "available" }),
    open: vi.fn().mockResolvedValue({ state: "open" }),
  };
}

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

  it("clears the discussion provider before repeated active plugin activation", () => {
    registerSessionDiscussionProvider(discussionProvider("clickclack"));

    clearActivatedPluginRuntimeState();

    expect(getSessionDiscussionProvider()).toBeUndefined();
  });

  it("restores the prior discussion provider when plugin activation rolls back", () => {
    const activeProvider = discussionProvider("clickclack");
    registerSessionDiscussionProvider(activeProvider);
    const transaction = createPluginRegistrationTransaction({});
    registerSessionDiscussionProvider(discussionProvider("replacement"));

    transaction.rollback();

    expect(getSessionDiscussionProvider()).toBe(activeProvider);
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

    registry.plugins[0].enabled = false;
    registry.plugins[0].status = "disabled";

    transaction.rollback();

    expect(registry.plugins[0].enabled).toBe(true);
    expect(registry.plugins[0].status).toBe("loaded");
  });
});
