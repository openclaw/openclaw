import { resolveGlobalMap } from "../shared/global-singleton.js";
import { registerOpenClawStatePathCacheInvalidation } from "../state/openclaw-state-db-cache.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { workspaceStatePublication } from "./workspace-state-publication.js";
import type { WorkspaceStateSnapshot } from "./workspace-state-types.js";

type Store = {
  identity: string;
  path: string;
  snapshots: Map<string, WorkspaceStateSnapshot>;
};

const stores = resolveGlobalMap<string, Store>(
  Symbol.for("openclaw.workspaceStateSnapshots"),
  "close-and-restart",
);

workspaceStatePublication.subscribeFacts((change) => {
  if (change.kind !== "unknown" && change.kind !== "committed") {
    return;
  }
  if (change.kind === "committed" && change.receipt.facts.size === 0) {
    return;
  }
  const identity = change.kind === "unknown" ? change.identity : change.receipt.source.identity;
  for (const [key, store] of stores) {
    if (store.identity !== identity) {
      continue;
    }
    if (change.kind === "unknown" || change.receipt.facts.has("aliases")) {
      stores.delete(key);
      continue;
    }
    for (const [aliasKey, snapshot] of store.snapshots) {
      const fact = change.receipt.facts.get(snapshot.identity.workspaceKey);
      if (fact?.kind === "postimage") {
        store.snapshots.set(aliasKey, fact.value);
      } else if (fact) {
        store.snapshots.delete(aliasKey);
      }
    }
    // An in-flight read must not overwrite the committed postimage.
    stores.set(key, { ...store });
  }
});

registerOpenClawStatePathCacheInvalidation(stores);

/** Owning writes publish snapshots; alias changes retire the resolution cache. */
export async function readCachedWorkspaceStateSnapshot(
  context: OpenClawStateWorkerContext,
  aliasKey: string,
  read: () => Promise<WorkspaceStateSnapshot>,
): Promise<WorkspaceStateSnapshot> {
  context.admission.assertCurrent();
  const key = context.admission.coordinationKey;
  let store = stores.get(key);
  if (store && store.identity !== context.admission.identity.key) {
    stores.delete(key);
    store = undefined;
  }
  if (!store) {
    store = {
      identity: context.admission.identity.key,
      path: context.admission.identity.canonicalPath,
      snapshots: new Map(),
    };
    stores.set(key, store);
  }
  const cached = store.snapshots.get(aliasKey);
  if (cached) {
    return cached;
  }
  const snapshot = await read();
  context.admission.assertCurrent();
  // A write that settled during the read owns the next snapshot.
  if (stores.get(key) === store) {
    // First creation promotes the admission from a pathname to a physical file.
    // Only that physical owner can receive the subsequent write receipts.
    if (store.identity !== context.admission.identity.key) {
      stores.delete(key);
    } else {
      if (store.snapshots.size >= 128) {
        store.snapshots.delete(store.snapshots.keys().next().value!);
      }
      store.snapshots.set(aliasKey, snapshot);
    }
  }
  return snapshot;
}
