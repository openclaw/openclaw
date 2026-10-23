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
  const prepared = (
    entries: PreparedGatewayModelCatalog["entries"],
    overrides: Partial<Parameters<typeof createPreparedGatewayModelCatalog>[0]> = {},
  ) =>
    createPreparedGatewayModelCatalog({ entries, pluginRegistry, metadataSnapshot, ...overrides });
  const other = prepared([
    { provider: "unit-test", id: "other", name: "Other", contextTokens: 32_768 },
  ]);
  const onlyOther = (value = other) => new Map([["other", value]]);
  const view = (contextTokens: number) =>
    new Map([
      ["main", prepared([{ provider: "unit-test", id: "model", name: "Model", contextTokens }])],
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
  const publish = (event: Parameters<typeof notifyPreparedModelRuntimePublication>[0]) => {
    notifyPreparedModelRuntimePublication(event);
    return catalog.refresh();
  };
  const retained = () => {
    expect(catalog.current).toBe(original);
    expect(refreshed).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  };
  let original: typeof catalog.current;
  const adopted = (changed: ReadonlySet<string> | undefined) => {
    expect(refreshed).toHaveBeenLastCalledWith(changed);
    expect(catalog.current).toBe(next);
  };
  try {
    await catalog.refresh();
    expect(refreshed).toHaveBeenLastCalledWith(undefined);
    original = catalog.current;
    refreshed.mockClear();
    read.mockClear();
    await publish({ phase: "catalog-status", modelFactsChanged: false });
    retained();
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
    retained();

    // Provider publication does not finish the pending runtime replacement.
    await publish({ phase: "catalog-published" });
    expect(catalog.current).toBe(original);
    const successor = createDeferredCore();
    notifyPreparedModelRuntimePublication({ phase: "invalidated", replacement: successor.promise });
    first.resolve();
    await first.promise;
    await catalog.refresh();
    retained();

    next = view(8_192);
    successor.resolve();
    await successor.promise;
    await publish({ phase: "published" });
    adopted(new Set());

    // A scoped auth refresh can finish without a global publication.
    notifyPreparedModelRuntimePublication({ phase: "invalidated" });
    next = view(16_384);
    await catalog.refresh();
    adopted(new Set(["main"]));

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
    adopted(undefined);

    next = onlyOther();
    await publish({ phase: "catalog-published" });
    adopted(undefined);

    const replacementRegistry = createEmptyPluginRegistry();
    // Registry and metadata identities alone do not change row policy.
    for (const nextMetadata of [metadataSnapshot, createPluginMetadataSnapshotFixture()]) {
      next = onlyOther(
        prepared(other.entries, {
          pluginRegistry: replacementRegistry,
          metadataSnapshot: nextMetadata,
        }),
      );
      await publish({ phase: "catalog-published" });
      adopted(new Set());
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
      next = onlyOther(
        prepared(other.entries, {
          pluginRegistry: replacementRegistry,
          metadataSnapshot: harnessMetadata,
          config,
        }),
      );
      await publish({ phase: "catalog-published" });
      // Config still controls an unloaded harness even with identical index and registrations.
      expect(refreshed).toHaveBeenLastCalledWith(new Set(["other"]));
    }
  } finally {
    catalog.dispose();
  }
});
