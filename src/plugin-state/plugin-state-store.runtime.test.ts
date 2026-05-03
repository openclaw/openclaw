import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginRecord } from "../plugins/registry-types.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resetPluginStateStoreForTests } from "./plugin-state-store.js";

function createPluginRecord(id: string, origin: PluginRecord["origin"] = "bundled"): PluginRecord {
  return {
    id,
    name: id,
    source: `/plugins/${id}/index.ts`,
    origin,
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    cliBackendIds: [],
    providerIds: [],
    speechProviderIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    mediaUnderstandingProviderIds: [],
    imageGenerationProviderIds: [],
    videoGenerationProviderIds: [],
    musicGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    migrationProviderIds: [],
    memoryEmbeddingProviderIds: [],
    agentHarnessIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    gatewayDiscoveryServiceIds: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
  } as PluginRecord;
}

function createTestPluginRegistry() {
  return createPluginRegistry({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: createPluginRuntime(),
  });
}

afterEach(() => {
  resetPluginStateStoreForTests();
});

describe("plugin runtime state proxy", () => {
  it("binds openKeyedStore to the bundled plugin id and keeps resolveStateDir", async () => {
    await withOpenClawTestState({ label: "plugin-state-runtime" }, async (state) => {
      const registry = createTestPluginRegistry();
      const record = createPluginRecord("discord", "bundled");
      registry.registry.plugins.push(record);
      const api = registry.createApi(record, { config: {} });

      expect(api.runtime.state.resolveStateDir()).toBe(state.stateDir);
      const store = api.runtime.state.openKeyedStore<{ plugin: string }>({
        namespace: "runtime",
        maxEntries: 10,
      });
      await store.register("k", { plugin: "discord" });

      const telegram = createPluginRecord("telegram", "bundled");
      registry.registry.plugins.push(telegram);
      const telegramApi = registry.createApi(telegram, { config: {} });
      const telegramStore = telegramApi.runtime.state.openKeyedStore<{ plugin: string }>({
        namespace: "runtime",
        maxEntries: 10,
      });
      await expect(telegramStore.lookup("k")).resolves.toBeUndefined();
      await expect(store.lookup("k")).resolves.toEqual({ plugin: "discord" });
    });
  });

  it("rejects external plugins without manifest declaration", () => {
    const registry = createTestPluginRegistry();
    const record = createPluginRecord("external-plugin", "workspace");
    registry.registry.plugins.push(record);
    const api = registry.createApi(record, { config: {} });

    expect(() =>
      api.runtime.state.openKeyedStore({ namespace: "runtime", maxEntries: 10 }),
    ).toThrow('Plugin "external-plugin" cannot use openKeyedStore');
  });

  it("allows community plugins with manifest declaration", async () => {
    await withOpenClawTestState({ label: "plugin-state-community" }, async () => {
      const registry = createTestPluginRegistry();
      const record = createPluginRecord("community-plugin", "workspace");

      // Add contracts with usesKeyedStore capability
      record.contracts = {
        usesKeyedStore: true,
      };

      registry.registry.plugins.push(record);
      const api = registry.createApi(record, { config: {} });
      const store = api.runtime.state.openKeyedStore<{ data: string }>({
        namespace: "test",
        maxEntries: 10,
      });

      await store.register("key1", { data: "community" });
      await expect(store.lookup("key1")).resolves.toEqual({ data: "community" });
    });
  });

  it("enforces stricter limits for community plugins", async () => {
    await withOpenClawTestState({ label: "plugin-state-limits" }, async () => {
      const registry = createTestPluginRegistry();
      const record = createPluginRecord("community-plugin", "workspace");

      // Add contracts with usesKeyedStore capability
      record.contracts = {
        usesKeyedStore: true,
      };

      registry.registry.plugins.push(record);
      const api = registry.createApi(record, { config: {} });

      // Request 1000 entries but should be capped at 500 for community plugins
      const store = api.runtime.state.openKeyedStore<{ index: number }>({
        namespace: "limits",
        maxEntries: 1000,
      });

      // Fill up to the enforced limit (500)
      for (let i = 0; i < 500; i++) {
        await store.register(`key${i}`, { index: i });
      }

      // The 501st entry should trigger eviction of the oldest
      await store.register("key500", { index: 500 });
      const entries = await store.entries();
      expect(entries.length).toBeLessThanOrEqual(500);
    });
  });
});
