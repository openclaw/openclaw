import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginStateKeyedStore,
  type OpenKeyedStoreOptions,
  type PluginStateKeyedStore,
} from "../plugin-state/plugin-state-store.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { EmbeddingInput, EmbeddingProviderAdapter } from "./embedding-provider-types.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import type { MemoryPluginRuntime } from "./registry-contribution-types.js";
import { adoptPluginRegistryRecords, markPluginRegistryRetired } from "./registry-lifecycle.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRecord } from "./status.test-helpers.js";

vi.mock("../agents/memory-search.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/memory-search.js")>();
  return {
    ...actual,
    resolveMemorySearchConfig: (...args: Parameters<typeof actual.resolveMemorySearchConfig>) => {
      const settings = actual.resolveMemorySearchConfig(...args);
      // Scheduling is host-owned; isolate the real interval from filesystem notifications.
      return (
        settings && {
          ...settings,
          sync: {
            ...settings.sync,
            intervalMinutes: 1,
            watch: false,
            onSearch: false,
            onSessionStart: false,
          },
        }
      );
    },
  };
});

it("uses the adopted memory owner's provider for an interval armed before reload", async () => {
  const state = await createOpenClawTestState({
    scenario: "minimal",
    label: "memory-background-reload",
  });
  const providerId = "background-embedding";
  const config: OpenClawConfig = {
    plugins: { enabled: false },
    agents: { defaults: { workspace: state.workspaceDir } },
    memory: {
      search: {
        provider: providerId,
        model: "synthetic-embedding",
        fallback: "none",
        sources: ["memory"],
        rememberAcrossConversations: false,
        store: { vector: { enabled: false } },
      },
    },
  };
  const first = createTestPluginRegistry();
  const next = createTestPluginRegistry();
  const memoryRecord = createPluginRecord({ id: "memory-core", origin: "bundled" });
  first.registry.plugins.push(memoryRecord);
  const memoryOwner = new PluginInstance(memoryRecord.id, {
    record: memoryRecord,
    registry: first.registry,
  });
  const registerProvider = (registry: typeof first, adapter: EmbeddingProviderAdapter) => {
    const record = createPluginRecord({
      id: providerId,
      contracts: { embeddingProviders: [providerId] },
    });
    registry.registry.plugins.push(record);
    registry.createApi(record, { config }).registerEmbeddingProvider(adapter);
    const instance = getPluginInstance(record);
    assert(instance);
    return instance;
  };
  const retiredCreate = vi.fn<EmbeddingProviderAdapter["create"]>(async () => {
    throw new Error("The retired provider must not be called");
  });
  const retiredProvider = registerProvider(first, {
    id: providerId,
    transport: "remote",
    create: retiredCreate,
  });
  const embeddedTexts: string[] = [];
  const replacementCreate = vi.fn<EmbeddingProviderAdapter["create"]>(async () => ({
    provider: {
      id: providerId,
      model: "synthetic-embedding",
      embed: async () => [1, 0, 0],
      embedBatch: async (inputs: EmbeddingInput[]) => {
        embeddedTexts.push(
          ...inputs.map((input) => (typeof input === "string" ? input : input.text)),
        );
        return inputs.map(() => [1, 0, 0]);
      },
    },
  }));
  const replacementProvider = registerProvider(next, {
    id: providerId,
    transport: "remote",
    create: replacementCreate,
  });
  let manager:
    | Awaited<ReturnType<MemoryPluginRuntime["getMemorySearchManager"]>>["manager"]
    | undefined;
  let backgroundSync: Promise<void> | undefined;
  let fireInterval: (() => void) | undefined;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const fakeSetInterval = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation((callback, delay, ...args) => {
    if (delay === 60_000) {
      // Fake timers do not retain AsyncLocalStorage like a real Node timer does.
      const runInArmingContext = AsyncLocalStorage.snapshot();
      fireInterval = () => runInArmingContext(callback, ...args);
    }
    return fakeSetInterval(callback, delay, ...args);
  });
  try {
    const runtime = await memoryOwner.run(() =>
      loadBundledPluginFacade<{
        getMemorySearchManager: MemoryPluginRuntime["getMemorySearchManager"];
        configureMemoryCoreDreamingState: (
          openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
        ) => void;
      }>({ pluginId: "memory-core", artifactBasename: "runtime-api.js" }),
    );
    runtime.configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) =>
      createPluginStateKeyedStore<T>(memoryRecord.id, { ...options, env: state.env }),
    );
    const result = await memoryOwner.run(() =>
      runtime.getMemorySearchManager({ cfg: config, agentId: "main" }),
    );
    const activeManager = result.manager;
    assert(activeManager, result.error ?? "Expected a persistent memory manager");
    manager = activeManager;
    assert(activeManager.sync);
    assert(fireInterval, "The persistent manager did not arm interval sync");
    const sync = activeManager.sync.bind(activeManager);
    vi.spyOn(activeManager, "sync").mockImplementation((params) => {
      backgroundSync = sync(params);
      return backgroundSync;
    });

    next.registry.plugins.push(memoryRecord);
    adoptPluginRegistryRecords(next.registry);
    markPluginRegistryRetired(first.registry);
    await retiredProvider.dispose();
    const content = "Celadon observatory stores the replacement telescope calibration.";
    await fs.writeFile(path.join(state.workspaceDir, "MEMORY.md"), content);

    fireInterval();
    assert(backgroundSync, "The armed callback did not enter memory sync");
    await backgroundSync;
    expect(retiredCreate).not.toHaveBeenCalled();
    expect(replacementCreate).toHaveBeenCalledOnce();
    expect(embeddedTexts).toContain(content);
    const dbPath = memoryOwner.run(() => activeManager.status()).dbPath;
    assert(dbPath);
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // Read durable output directly so foreground search cannot repair a missed background sync.
      expect(database.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
        { text: content },
      ]);
    } finally {
      database.close();
    }
  } finally {
    await backgroundSync?.catch(() => undefined);
    await manager?.close?.();
    await memoryOwner.dispose();
    await retiredProvider.dispose();
    await replacementProvider.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
    await state.cleanup();
  }
});
