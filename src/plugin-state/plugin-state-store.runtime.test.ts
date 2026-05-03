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
        maxEntries: 10,
      });
      await store.register("k", { plugin: "discord" });

      const telegram = createPluginRecord("telegram", "bundled");
      registry.registry.plugins.push(telegram);
      const telegramApi = registry.createApi(telegram, { config: {} });
      const telegramStore = telegramApi.runtime.state.openKeyedStore<{ plugin: string }>({
        maxEntries: 10,
      });
      await expect(telegramStore.lookup("k")).resolves.toBeUndefined();
      await expect(store.lookup("k")).resolves.toEqual({ plugin: "discord" });
    });
  });

  it("allows workspace plugins and keeps owner isolation", async () => {
    await withOpenClawTestState({ label: "plugin-state-runtime-workspace" }, async () => {
      const registry = createTestPluginRegistry();
      const external = createPluginRecord("external-state-plugin", "workspace");
      registry.registry.plugins.push(external);
      const api = registry.createApi(external, { config: {} });

      const store = api.runtime.state.openKeyedStore<{ plugin: string }>({
        maxEntries: 10,
      });
      await store.register("k", { plugin: "external-state-plugin" });

      const sibling = createPluginRecord("sibling-state-plugin", "workspace");
      registry.registry.plugins.push(sibling);
      const siblingApi = registry.createApi(sibling, { config: {} });
      const siblingStore = siblingApi.runtime.state.openKeyedStore<{ plugin: string }>({
        maxEntries: 10,
      });

      await expect(siblingStore.lookup("k")).resolves.toBeUndefined();
      await expect(store.lookup("k")).resolves.toEqual({ plugin: "external-state-plugin" });
    });
  });

  it("uses a default row budget when options are omitted", async () => {
    await withOpenClawTestState({ label: "plugin-state-runtime-defaults" }, async () => {
      const registry = createTestPluginRegistry();
      const record = createPluginRecord("external-plugin", "workspace");
      registry.registry.plugins.push(record);
      const api = registry.createApi(record, { config: {} });

      const store = api.runtime.state.openKeyedStore<{ ok: boolean }>({});
      await store.register("k", { ok: true });
      await expect(store.lookup("k")).resolves.toEqual({ ok: true });
    });
  });
});
