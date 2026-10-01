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
