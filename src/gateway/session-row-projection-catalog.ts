import { isDeepStrictEqual } from "node:util";
import { registerPreparedModelRuntimePublicationListener } from "../agents/prepared-model-runtime.publication-events.js";
import { readPreparedGatewaySessionRowPolicy } from "./server-model-catalog-view.js";
import type { Inputs } from "./session-row-projection-record.js";

function changedModelAgents(previous: Inputs["modelCatalog"], next: Inputs["modelCatalog"]) {
  // Missing policy owners can still resolve rows through active plugin metadata.
  if (
    !(previous instanceof Map) ||
    !(next instanceof Map) ||
    previous.size === 0 ||
    previous.size !== next.size
  ) {
    return undefined;
  }
  const changed = new Set<string>();
  for (const [agentId, catalog] of previous) {
    const replacement = next.get(agentId);
    if (
      catalog === undefined ||
      replacement === undefined ||
      readPreparedGatewaySessionRowPolicy(catalog) === undefined ||
      readPreparedGatewaySessionRowPolicy(replacement) === undefined
    ) {
      return undefined;
    }
    if (
      !isDeepStrictEqual(
        readPreparedGatewaySessionRowPolicy(catalog),
        readPreparedGatewaySessionRowPolicy(replacement),
      )
    ) {
      changed.add(agentId);
    }
  }
  return changed;
}

/** The projection's one catalog snapshot survives asynchronous renewal. */
export function createSessionRowProjectionCatalog(params: {
  modelCatalog?: Inputs["modelCatalog"];
  getModelCatalog?: () => Promise<Inputs["modelCatalog"]>;
  onInvalidated: () => void;
  onRefreshed: (changedAgents: ReadonlySet<string> | undefined) => void;
}) {
  let modelCatalog = params.modelCatalog;
  let catalogDirty = Boolean(params.getModelCatalog);
  let pending: Promise<void> | undefined;
  let replacement: Promise<void> | undefined;
  let disposed = false;
  const unsubscribe = registerPreparedModelRuntimePublicationListener((event) => {
    if (event.phase === "catalog-status") {
      return;
    }
    if (event.phase === "invalidated" && event.replacement) {
      replacement = event.replacement;
      const settled = () => {
        // A superseded reload must not release its successor's catalog gate.
        if (!disposed && replacement === event.replacement) {
          replacement = undefined;
          params.onInvalidated();
        }
      };
      // Scoped auth invalidations need not publish globally; only the owner gate can pause reads.
      void replacement.then(settled, settled).catch(() => {});
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
      return catalogDirty && modelCatalog === undefined;
    },
    invalidate() {
      if (params.getModelCatalog) {
        catalogDirty = true;
      }
    },
    refresh() {
      if (disposed || !catalogDirty || (replacement && modelCatalog !== undefined)) {
        return Promise.resolve();
      }
      if (pending) {
        return pending;
      }
      const work = (async () => {
        const next = await params.getModelCatalog?.();
        // Replacement can begin while the catalog read yields.
        if (disposed || (replacement && modelCatalog !== undefined)) {
          return;
        }
        // A concurrent catalog change is adopted by the next publication.
        const changed = changedModelAgents(modelCatalog, next);
        modelCatalog = next;
        catalogDirty = false;
        params.onRefreshed(changed);
      })().finally(() => {
        pending = undefined;
      });
      pending = work;
      void work.catch(() => {});
      return work;
    },
    dispose() {
      disposed = true;
      unsubscribe();
    },
  };
}
