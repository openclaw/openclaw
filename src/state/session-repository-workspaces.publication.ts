import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import type { OpenClawStateDatabaseReadAdmission } from "./openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "./openclaw-state-db-cache.js";
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
type Store = { path: string; rows: Map<string, Row> };
const stores = resolveGlobalMap<string, Store>(
  Symbol.for("openclaw.repositoryWorkspacePublications"),
  "close-and-restart",
);

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
    store = { path: admission.identity.canonicalPath, rows: new Map() };
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
          if (!result.workspace) {
            // Existing views retain the tombstone; the owner need not retain deleted rows.
            store.rows.delete(result.workspaceId);
          }
        }
        row.uncertain = !known;
      }
      row.pending.delete(pending.promise);
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
  const row = rowFor(store, workspaceId);
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
    const revision = row.revision;
    const workspace = await read();
    assertSource();
    if (revision !== row.revision || row.pending.size) {
      continue;
    }
    row.value = copy(workspace);
    row.uncertain = false;
    if (!workspace && store.rows.get(workspaceId) === row) {
      store.rows.delete(workspaceId);
    }
    return {
      workspace: row.value,
      assertSourceCurrent: assertSource,
      current() {
        assertSource();
        if (row.pending.size || row.uncertain) {
          throw new Error("Repository workspace mutation has not settled; refresh this session");
        }
        return row.value;
      },
    };
  }
}
