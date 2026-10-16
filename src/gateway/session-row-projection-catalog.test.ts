import { expect, it, vi } from "vitest";
import { notifyPreparedModelRuntimePublication } from "../agents/prepared-model-runtime.publication-events.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createPreparedGatewayModelCatalog } from "./server-model-catalog-view.js";
import type { PreparedGatewayModelCatalog } from "./server-model-catalog.types.js";
import { createSessionRowProjectionCatalog } from "./session-row-projection-catalog.js";

it("retains completed catalog facts during runtime replacement and adopts completed or failed publications", async () => {
  const pluginRegistry = createEmptyPluginRegistry();
  const metadataSnapshot = createPluginMetadataSnapshotFixture();
  const other = createPreparedGatewayModelCatalog({
    entries: [{ provider: "unit-test", id: "other", name: "Other", contextTokens: 32_768 }],
    pluginRegistry,
    metadataSnapshot,
  });
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
      ["other", other],
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
    expect(refreshed).toHaveBeenLastCalledWith(undefined);
    const original = catalog.current;
    refreshed.mockClear();
    read.mockClear();
    notifyPreparedModelRuntimePublication({ phase: "catalog-status", modelFactsChanged: false });
    await catalog.refresh();
    expect(catalog.current).toBe(original);
    expect(read).not.toHaveBeenCalled();
    expect(refreshed).not.toHaveBeenCalled();
    const first = createDeferredCore();
    const reading = createDeferredCore<typeof next>();
    read.mockReturnValueOnce(reading.promise);
    catalog.invalidate();
    const inFlight = catalog.refresh();
    notifyPreparedModelRuntimePublication({ phase: "invalidated", replacement: first.promise });
    next = new Map([
      ["main", undefined],
      ["other", other],
    ]);
    reading.resolve(next);
    await inFlight;
    expect(catalog.current).toBe(original);
    expect(refreshed).not.toHaveBeenCalled();
    read.mockClear();
    await catalog.refresh();
    expect(catalog.current).toBe(original);
    expect(refreshed).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();

    // Provider publication does not finish the pending runtime replacement.
    notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
    await catalog.refresh();
    expect(catalog.current).toBe(original);
    const successor = createDeferredCore();
    notifyPreparedModelRuntimePublication({ phase: "invalidated", replacement: successor.promise });
    first.resolve();
    await first.promise;
    await catalog.refresh();
    expect(catalog.current).toBe(original);
    expect(refreshed).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();

    next = view(8_192);
    successor.resolve();
    await successor.promise;
    notifyPreparedModelRuntimePublication({ phase: "published" });
    await catalog.refresh();
    expect(refreshed).toHaveBeenLastCalledWith(new Set());
    expect(catalog.current).toBe(next);

    // A scoped auth refresh can finish without a global publication.
    notifyPreparedModelRuntimePublication({ phase: "invalidated" });
    next = view(16_384);
    await catalog.refresh();
    expect(refreshed).toHaveBeenLastCalledWith(new Set(["main"]));
    expect(catalog.current).toBe(next);

    const failed = createDeferredCore();
    notifyPreparedModelRuntimePublication({ phase: "invalidated", replacement: failed.promise });
    next = new Map([
      ["main", undefined],
      ["other", other],
    ]);
    notifyPreparedModelRuntimePublication({ phase: "failed", error: new Error("Refresh failed") });
    failed.reject(new Error("Refresh failed"));
    await failed.promise.catch(() => {});
    await catalog.refresh();
    expect(refreshed).toHaveBeenLastCalledWith(undefined);
    expect(catalog.current).toBe(next);

    next = new Map([["other", other]]);
    notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
    await catalog.refresh();
    expect(refreshed).toHaveBeenLastCalledWith(undefined);
    expect(catalog.current).toBe(next);

    const replacementRegistry = createEmptyPluginRegistry();
    // Registry and metadata identities alone do not change row policy.
    for (const nextMetadata of [metadataSnapshot, createPluginMetadataSnapshotFixture()]) {
      next = new Map([
        [
          "other",
          createPreparedGatewayModelCatalog({
            entries: other.entries,
            pluginRegistry: replacementRegistry,
            metadataSnapshot: nextMetadata,
          }),
        ],
      ]);
      notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
      await catalog.refresh();
      expect(refreshed).toHaveBeenLastCalledWith(new Set());
      expect(catalog.current).toBe(next);
    }
    const harnessMetadata = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "unregistered-harness",
          origin: "global",
          activation: { onAgentHarnesses: ["synthetic"] },
        },
      ],
    });
    for (const config of [
      {},
      { plugins: { entries: { "unregistered-harness": { enabled: false } } } },
    ]) {
      next = new Map([
        [
          "other",
          createPreparedGatewayModelCatalog({
            entries: other.entries,
            pluginRegistry: replacementRegistry,
            metadataSnapshot: harnessMetadata,
            config,
          }),
        ],
      ]);
      notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
      await catalog.refresh();
      // Config still controls an unloaded harness even with identical index and registrations.
      expect(refreshed).toHaveBeenLastCalledWith(new Set(["other"]));
    }
  } finally {
    catalog.dispose();
  }
});
