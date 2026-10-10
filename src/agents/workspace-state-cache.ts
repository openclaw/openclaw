import { resolveGlobalMap } from "../shared/global-singleton.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../state/openclaw-state-db-cache.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { workspaceStatePublication } from "./workspace-state-publication.js";
import type { WorkspaceStateSnapshot } from "./workspace-state-store.kernel.js";

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
    if (store.identity === identity) {
      stores.delete(key);
    }
  }
});

registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind !== "opened") {
    for (const [key, store] of stores) {
      if (store.path === (event.identity?.canonicalPath ?? event.path)) {
        stores.delete(key);
      }
    }
  }
});

/** A workspace write invalidates the whole small projection, including alias resolution. */
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
    return structuredClone(cached);
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
      store.snapshots.set(aliasKey, structuredClone(snapshot));
    }
  }
  return snapshot;
}
