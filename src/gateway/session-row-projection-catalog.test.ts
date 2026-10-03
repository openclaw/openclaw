import { expect, it, vi } from "vitest";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import { notifyPreparedModelRuntimePublication } from "../agents/prepared-model-runtime.publication-events.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { prepareModelCatalogThinkingPolicies } from "../plugins/provider-thinking.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { isPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import {
  disposePluginRegistryInstances,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createPreparedGatewayModelCatalog } from "./server-model-catalog-view.js";
import type { PreparedGatewayModelCatalog } from "./server-model-catalog.types.js";
import { readSessionRowModelFacts } from "./session-row-model-facts.js";
import { createSessionRowProjectionCatalog } from "./session-row-projection-catalog.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";

it("retains completed catalog facts during runtime replacement and adopts completed or failed publications", async () => {
  const pluginRegistry = createEmptyPluginRegistry();
  const metadataSnapshot = createPluginMetadataSnapshotFixture();
  const view = (contextTokens: number) =>
    new Map([
      [
        "main",
        createPreparedGatewayModelCatalog({
          entries: [{ provider: "unit-test", id: "model", name: "Model", contextTokens }],
          pluginRegistry,
          metadataSnapshot,
        }),
      ],
    ]);
  let next: Map<string, PreparedGatewayModelCatalog | undefined> = view(8_192);
  const read = vi.fn(async () => next);
  const refreshed = vi.fn();
  const catalog = createSessionRowProjectionCatalog({
    getModelCatalog: read,
    onInvalidated: () => catalog.invalidate(),
    onRefreshed: refreshed,
  });
  try {
    await catalog.refresh();
    const original = catalog.current;
    refreshed.mockClear();
    read.mockClear();
    const first = createDeferredCore();
    notifyPreparedModelRuntimePublication({ phase: "invalidated", replacement: first.promise });
    next = new Map([["main", undefined]]);
    await catalog.refresh();
    expect(catalog.current).toBe(original);
    expect(refreshed).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();

    // Provider publication does not finish the pending runtime replacement.
    notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
    await catalog.refresh();
    expect(catalog.current).toBe(original);
    const second = createDeferredCore();
    notifyPreparedModelRuntimePublication({ phase: "invalidated", replacement: second.promise });
    first.resolve();
    await first.promise;
    await catalog.refresh();
    expect(catalog.current).toBe(original);
    next = view(8_192);
    second.resolve();
    await second.promise;
    notifyPreparedModelRuntimePublication({ phase: "published" });
    await catalog.refresh();
    expect(refreshed).toHaveBeenLastCalledWith(false);
    expect(catalog.current).toBe(next);

    // A scoped auth refresh can finish without a global publication.
    notifyPreparedModelRuntimePublication({ phase: "invalidated" });
    next = view(16_384);
    await catalog.refresh();
    expect(refreshed).toHaveBeenLastCalledWith(true);
    expect(catalog.current).toBe(next);

    const failed = createDeferredCore();
    notifyPreparedModelRuntimePublication({ phase: "invalidated", replacement: failed.promise });
    next = new Map([["main", undefined]]);
    notifyPreparedModelRuntimePublication({ phase: "failed", error: new Error("Refresh failed") });
    failed.reject(new Error("Refresh failed"));
    await failed.promise.catch(() => {});
    await catalog.refresh();
    expect(refreshed).toHaveBeenLastCalledWith(true);
    expect(catalog.current).toBe(next);
  } finally {
    catalog.dispose();
  }
});

it("does not execute a retired prepared thinking policy while adopting its replacement", async () => {
  const provider = "retired-policy-fixture";
  const model = "reasoner";
  const metadataSnapshot = createPluginMetadataSnapshotFixture();
  const activeRegistry = createEmptyPluginRegistry();
  activeRegistry.providers.push({
    pluginId: "active-policy",
    source: "test",
    provider: {
      id: provider,
      label: "Active policy",
      auth: [],
      resolveThinkingProfile: () => ({
        levels: [{ id: "off" }, { id: "high" }],
        defaultLevel: "high",
      }),
    },
  });
  setActivePluginRegistry(activeRegistry);

  const registries: ReturnType<typeof createEmptyPluginRegistry>[] = [];
  // Build the same process-local policy carrier that prepared runtime publication gives rows.
  const view = (defaultLevel: "low" | "max") => {
    const pluginRegistry = createEmptyPluginRegistry();
    registries.push(pluginRegistry);
    const record = createPluginRecord({ id: `${defaultLevel}-policy` });
    pluginRegistry.plugins.push(record);
    const instance = new PluginInstance(record.id, { record, registry: pluginRegistry });
    pluginRegistry.providers.push({
      pluginId: instance.pluginId,
      source: "test",
      provider: instance.wrap({
        id: provider,
        label: `${defaultLevel} policy`,
        auth: [],
        resolveThinkingProfile: () => ({
          levels: [{ id: "off" as const }, { id: defaultLevel }],
          defaultLevel,
        }),
      }),
    });
    const modelCatalog: ModelCatalogSnapshot = {
      entries: [{ provider, id: model, name: "Reasoner", reasoning: true }],
      routeVariants: [],
    };
    const preparation = {
      catalog: modelCatalog,
      metadataSnapshot,
      pluginRegistry,
    };
    prepareModelCatalogThinkingPolicies(preparation);
    return new Map([
      [
        "main",
        createPreparedGatewayModelCatalog({
          ...modelCatalog,
          pluginRegistry,
          metadataSnapshot,
        }),
      ],
    ]);
  };

  let next: Map<string, PreparedGatewayModelCatalog | undefined> = view("low");
  const originalRegistry = registries[0]!;
  const catalog = createSessionRowProjectionCatalog({
    getModelCatalog: async () => next,
    onInvalidated: () => catalog.invalidate(),
    onRefreshed: () => {},
  });
  const cfg: OpenClawConfig = {
    agents: { defaults: { model: { primary: `${provider}/${model}` } } },
  };
  const readRow = () =>
    readSessionRowModelFacts({
      cfg,
      key: "agent:main:main",
      agentId: "main",
      source: { entry: undefined, readSourceEntry: () => undefined },
      rowContext: buildSessionListRowMetadataContext({ now: 1 }),
      modelCatalog: catalog.current,
    });

  try {
    await catalog.refresh();
    expect(readRow().thinkingProjection.thinkingDefault).toBe("low");

    // Renewal retains the completed data view while its callback owner retires.
    const replacement = createDeferredCore();
    notifyPreparedModelRuntimePublication({
      phase: "invalidated",
      replacement: replacement.promise,
    });
    next = view("max");
    const disposalGate = createDeferredCore();
    const disposal = disposePluginRegistryInstances(originalRegistry, undefined, {
      beforeDispose: () => disposalGate.promise,
    });

    // Quiesce closes admission before asynchronous disposal can finish.
    expect(isPluginRegistryRetired(originalRegistry)).toBe(true);
    try {
      expect(() => readRow()).not.toThrow();
      expect(readRow().thinkingProjection.thinkingDefault).toBe("high");
    } finally {
      disposalGate.resolve();
      await disposal;
    }
    expect(() => readRow()).not.toThrow();
    expect(readRow().thinkingProjection.thinkingDefault).toBe("high");

    // Settling the exact owner gate resumes refresh and adopts the successor policy.
    replacement.resolve();
    await replacement.promise;
    await catalog.refresh();
    expect(catalog.current).toBe(next);
    expect(readRow().thinkingProjection.thinkingDefault).toBe("max");
  } finally {
    catalog.dispose();
    await Promise.all(registries.map((registry) => disposePluginRegistryInstances(registry)));
    resetPluginRuntimeStateForTest();
  }
});
