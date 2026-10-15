import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import type { OpenClawStateDatabaseReadAdmission } from "./openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "./openclaw-state-db-cache.js";
import { repositoryWorkspacePublication } from "./session-repository-workspaces.receipts.js";
import type {
  RepositoryWorkspaceMutationResult,
  SessionRepositoryWorkspaceRecord,
} from "./session-repository-workspaces.types.js";

type Row = {
  revision: object;
  value: Readonly<SessionRepositoryWorkspaceRecord> | undefined;
  pending: Set<Promise<void>>;
  uncertain: boolean;
};
type Store = { path: string; identity: string; rows: Map<string, Row> };
const stores = resolveGlobalMap<string, Store>(
  Symbol.for("openclaw.repositoryWorkspacePublications"),
  "close-and-restart",
);

repositoryWorkspacePublication.subscribeFacts((change) => {
  if (change.kind !== "committed" && change.kind !== "unknown") {
    return;
  }
  if (change.kind === "committed" && change.receipt.facts.size === 0) {
    return;
  }
  const identity = change.kind === "committed" ? change.receipt.source.identity : change.identity;
  for (const store of stores.values()) {
    if (store.identity !== identity) {
      continue;
    }
    if (change.kind === "unknown") {
      for (const row of store.rows.values()) {
        row.revision = {};
        row.uncertain = true;
      }
      continue;
    }
    for (const [key, fact] of change.receipt.facts) {
      const row = store.rows.get(key);
      if (!row || fact.kind === "unchanged") {
        continue;
      }
      row.revision = {};
      row.uncertain = fact.kind === "unknown";
      if (fact.kind === "postimage") {
        row.value = copy(fact.value);
      }
      if (fact.kind === "absent") {
        row.value = undefined;
        store.rows.delete(key);
      }
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

function owner(admission: OpenClawStateDatabaseReadAdmission): Store {
  admission.assertCurrent();
  let store = stores.get(admission.coordinationKey);
  if (!store) {
    store = {
      path: admission.identity.canonicalPath,
      identity: admission.identity.key,
      rows: new Map(),
    };
    stores.set(admission.coordinationKey, store);
  }
  return store;
}

function rowFor(store: Store, workspaceId: string): Row {
  let row = store.rows.get(workspaceId);
  if (!row) {
    row = { revision: {}, value: undefined, pending: new Set(), uncertain: false };
    store.rows.set(workspaceId, row);
  }
  return row;
}

function copy(workspace: SessionRepositoryWorkspaceRecord | undefined) {
  return workspace ? Object.freeze({ ...workspace }) : undefined;
}

/** Fence current-fact consumers before COMMIT and reopen them only after native settlement. */
export function stageRepositoryWorkspacePublication(
  admission: OpenClawStateDatabaseReadAdmission,
  result: RepositoryWorkspaceMutationResult,
) {
  const store = owner(admission);
  const row = rowFor(store, result.workspaceId);
  const pending = createDeferredCore();
  const revision = {};
  row.revision = revision;
  row.pending.add(pending.promise);
  let settled = false;
  return {
    settle(committed: boolean, known: boolean) {
      if (settled) {
        return;
      }
      settled = true;
      if (stores.get(admission.coordinationKey) === store && row.revision === revision) {
        if (committed) {
          row.value = copy(result.workspace);
        }
        row.uncertain = !known;
      }
      row.pending.delete(pending.promise);
      if (!row.value && row.pending.size === 0 && store.rows.get(result.workspaceId) === row) {
        store.rows.delete(result.workspaceId);
      }
      pending.resolve();
    },
  };
}

export type PreparedRepositoryWorkspace = {
  readonly workspace: Readonly<SessionRepositoryWorkspaceRecord> | undefined;
  /** Physical custody remains checkable while an owned checkpoint is settling. */
  assertSourceCurrent: () => void;
  /** Callers compare their own identity/revision requirements against current committed facts. */
  current: () => Readonly<SessionRepositoryWorkspaceRecord> | undefined;
};

export async function prepareRepositoryWorkspaceRead(
  admission: OpenClawStateDatabaseReadAdmission,
  workspaceId: string,
  read: () => Promise<SessionRepositoryWorkspaceRecord | undefined>,
): Promise<PreparedRepositoryWorkspace> {
  const store = owner(admission);
  let row = rowFor(store, workspaceId);
  const assertSource = () => {
    admission.assertCurrent();
    if (stores.get(admission.coordinationKey) !== store) {
      throw new Error("Repository workspace database owner changed");
    }
  };
  for (;;) {
    if (row.pending.size) {
      await Promise.all(row.pending);
    }
    assertSource();
    if (store.rows.get(workspaceId) !== row) {
      row = rowFor(store, workspaceId);
      continue;
    }
    const revision = row.revision;
    const workspace = await read();
    assertSource();
    if (revision !== row.revision || row.pending.size || store.rows.get(workspaceId) !== row) {
      continue;
    }
    row.value = copy(workspace);
    row.uncertain = false;
    if (!workspace) {
      store.rows.delete(workspaceId);
    }
    return {
      workspace: row.value,
      assertSourceCurrent: assertSource,
      current() {
        assertSource();
        if (row.pending.size || store.rows.get(workspaceId)?.pending.size || row.uncertain) {
          throw new Error("Repository workspace mutation has not settled; refresh this session");
        }
        return row.value;
      },
    };
  }
}
