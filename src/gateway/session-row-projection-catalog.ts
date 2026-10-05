import { isDeepStrictEqual } from "node:util";
import { registerPreparedModelRuntimePublicationListener } from "../agents/prepared-model-runtime.publication-events.js";
import { readPreparedGatewayModelCatalogMetadata } from "./server-model-catalog-view.js";
import type { Inputs } from "./session-row-projection-record.js";

function hasSameModelFacts(previous: Inputs["modelCatalog"], next: Inputs["modelCatalog"]) {
  // Missing policy owners can still resolve rows through active plugin metadata.
  if (!(previous instanceof Map) || !(next instanceof Map) || previous.size === 0) {
    return false;
  }
  return (
    previous.size === next.size &&
    [...previous].every(([agentId, catalog]) => {
      const replacement = next.get(agentId);
      const metadata = readPreparedGatewayModelCatalogMetadata(catalog);
      return (
        catalog !== undefined &&
        replacement !== undefined &&
        catalog.pluginRegistry !== undefined &&
        metadata !== undefined &&
        catalog.pluginRegistry === replacement.pluginRegistry &&
        metadata === readPreparedGatewayModelCatalogMetadata(replacement) &&
        isDeepStrictEqual(catalog.entries, replacement.entries) &&
        isDeepStrictEqual(catalog.routeVariants, replacement.routeVariants)
      );
    })
  );
}

/** The projection's one catalog snapshot survives asynchronous renewal. */
export function createSessionRowProjectionCatalog(params: {
  modelCatalog?: Inputs["modelCatalog"];
  getModelCatalog?: () => Promise<Inputs["modelCatalog"]>;
  onInvalidated: () => void;
  onRefreshed: (changed: boolean) => void;
}) {
  let modelCatalog = params.modelCatalog;
  let catalogDirty = params.getModelCatalog ? Symbol("catalog") : undefined;
  let pending: Promise<void> | undefined;
  let replacement: Promise<void> | undefined;
  let disposed = false;
  const unsubscribe = registerPreparedModelRuntimePublicationListener((event) => {
    if (event.phase === "catalog-status") {
      return;
    }
    if (event.phase === "invalidated" && event.replacement) {
      const replacing = (replacement = event.replacement);
      const settled = () => {
        if (!disposed && replacement === replacing) {
          replacement = undefined;
          params.onInvalidated();
        }
      };
      // Scoped auth invalidations need not publish globally; only the owner gate can pause reads.
      void replacing.then(settled, settled).catch(() => {});
    }
    // An incomplete catalog read still needs the next publication to recover its rows.
    if (
      event.phase !== "failed" &&
      event.modelFactsChanged === false &&
      modelCatalog !== undefined &&
      (!(modelCatalog instanceof Map) || ![...modelCatalog.values()].includes(undefined))
    ) {
      return;
    }
    params.onInvalidated();
  });
  return {
    get current() {
      return modelCatalog;
    },
    get isRefreshing() {
      return !disposed && pending !== undefined;
    },
    get needsInitialRead() {
      return Boolean(catalogDirty) && modelCatalog === undefined;
    },
    invalidate() {
      if (params.getModelCatalog) {
        catalogDirty = Symbol("catalog");
      }
    },
    refresh() {
      if (disposed || !catalogDirty || (replacement && modelCatalog !== undefined)) {
        return Promise.resolve();
      }
      if (pending) {
        return pending;
      }
      const revision = catalogDirty;
      const work = (async () => {
        try {
          const next = await params.getModelCatalog?.();
          pending = undefined;
          if (disposed || catalogDirty !== revision) {
            if (!disposed) {
              params.onRefreshed(false);
            }
            return;
          }
          // Catalog visibility and row invalidation share one synchronous publication.
          const changed = !hasSameModelFacts(modelCatalog, next);
          modelCatalog = next;
          catalogDirty = undefined;
          params.onRefreshed(changed);
        } catch (error) {
          pending = undefined;
          // Keep the revision dirty so the next publication or read can retry.
          throw error;
        }
      })();
      pending = work;
      void work.catch(() => {});
      return work;
    },
    dispose() {
      disposed = true;
      unsubscribe();
    },
    async freeze() {
      disposed = true;
      unsubscribe();
      // Retain completed facts and join the exact renewal; a rejected read
      // cannot publish or replace the already retained frozen catalog.
      await pending?.catch(() => {});
      catalogDirty = undefined;
    },
  };
}

/** Publication retirement and final disposal share this projection's retained owners. */
export function createSessionRowProjectionRetirement(params: {
  stop: readonly (() => void)[];
  markDisposed: () => void;
  markFrozen: () => void;
  resources: readonly { dispose: () => void }[];
  publishers: readonly { dispose: () => void }[];
  indexes: readonly { clear: () => void }[];
  finishDisposal: () => void;
  catalog: { freeze: () => Promise<void> };
  ensureMaterialized: () => Promise<void>;
  disposeRefresh: () => void;
  captureConfig: () => void;
}) {
  const stopPublication = () => {
    for (const unsubscribe of params.stop) {
      unsubscribe();
    }
  };
  return {
    dispose: () => {
      params.markDisposed();
      params.disposeRefresh();
      for (const resource of params.resources) {
        resource.dispose();
      }
      stopPublication();
      for (const index of params.indexes) {
        index.clear();
      }
      params.finishDisposal();
    },
    freeze: async () => {
      stopPublication();
      params.markFrozen();
      for (const publisher of params.publishers) {
        publisher.dispose();
      }
      await params.catalog.freeze();
      await params.ensureMaterialized();
      params.disposeRefresh();
      params.captureConfig();
    },
  };
}

export function createFrozenSessionRowProjectionConfig(
  config: () => import("../config/types.openclaw.js").OpenClawConfig,
  policy: () => import("../config/types.openclaw.js").OpenClawConfig,
) {
  let active = false;
  let snapshot: import("../config/types.openclaw.js").OpenClawConfig | undefined;
  return {
    get active() {
      return active;
    },
    get captured() {
      return snapshot !== undefined;
    },
    begin: () => {
      active = true;
    },
    policy: () => snapshot ?? policy(),
    capture: () => {
      const cfg = structuredClone(config());
      snapshot = structuredClone(policy());
      return cfg;
    },
  };
}
