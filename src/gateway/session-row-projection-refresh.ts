import { WorkerTaskError } from "@openclaw/worker-runtime";
import { MAX_SESSION_ROW_FACTS_KEYS } from "../config/sessions/session-transcript-worker.types.js";
import {
  DEFAULT_WORKER_PENDING_BYTES,
  DEFAULT_WORKER_PENDING_TASKS,
} from "../infra/worker-task-capacity.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { yieldSessionListWork } from "./session-projection-work.js";
import { withSessionRowDatabaseFacts } from "./session-row-database-facts.js";
import { isColdArchivedSessionRow as isCold } from "./session-row-projection-archive.js";
import { createSessionRowMaterializer } from "./session-row-projection-materialize.js";
import * as records from "./session-row-projection-record.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";

type MaterializationOwner = Parameters<typeof createSessionRowMaterializer>[0];
type ExactRowPreparation = { completion: Deferred; store: string; bytes: number };
// Independent archived pages may retain their read scopes concurrently.
const MAX_CONCURRENT_EXACT_ROW_READS = 2;

/** Refreshes borrow projection state; the projection retains revisions, rows, and archive custody. */
export function createSessionRowRefresh(
  owner: Omit<MaterializationOwner, "isActive"> & {
    state: () => {
      cfg: records.Inputs["cfg"];
      disposed: boolean;
      topologyDirty: boolean;
      registryPrepared: boolean;
    };
    env: NodeJS.ProcessEnv;
    runAsOwner: <T>(operation: () => T) => T;
    lookup: (query: records.Lookup) => records.Row | undefined;
    prepareRegistryFacts: () => Promise<void> | undefined;
    topology: () => Promise<void>;
    catalog: { needsInitialRead: boolean; isRefreshing: boolean; refresh: () => Promise<unknown> };
    placementFacts: { prepare: () => Promise<void>; needsPreparation: boolean };
    membership: { prepare: () => Promise<void>; needsPreparation: boolean };
  },
) {
  const materializer = createSessionRowMaterializer({
    ...owner,
    isActive: () => !owner.state().disposed,
  });
  const exactReads = new Map<string, ExactRowPreparation>();
  const queuedExactReads = new Map<string, ExactRowPreparation>();
  // Each row has one in-flight worker read: bulk batches skip exact-owned rows,
  // and exact preparations join a bulk read already holding their row.
  const bulkReads = new Map<string, Promise<void>>();
  let activeExactReads = 0;
  let exactReadBytes = 0;
  let exactPreparations = 0;
  let exactPreparationsIdle: Deferred | undefined;
  let selectionPreparation: Promise<void> | undefined;
  // Admission and the background drain must share each pending database acquisition.
  let refreshing: Promise<void> | undefined;
  function releaseExactRead(id: string, read: ExactRowPreparation) {
    exactReads.delete(id);
    exactReadBytes -= read.bytes;
  }
  async function readExactBatch(batch: Map<string, ExactRowPreparation>) {
    try {
      if (!owner.state().disposed) {
        const selected = new Set(
          [...batch.keys()].filter((id) => {
            const row = owner.rows.get(id);
            return row && (owner.dirty.has(id) || isCold(row));
          }),
        );
        if (selected.size > 0) {
          await owner.runAsOwner(() => readRows(selected, { archived: true }));
          // Retained facts can finish through microtasks; let the loop run between row slices.
          await yieldSessionListWork();
        }
      }
      for (const read of batch.values()) {
        read.completion.resolve();
      }
    } catch (error) {
      for (const read of batch.values()) {
        read.completion.reject(error);
      }
    } finally {
      for (const [id, read] of batch) {
        releaseExactRead(id, read);
      }
      activeExactReads--;
      queueMicrotask(dispatchExactReads);
    }
  }
  function dispatchExactReads() {
    while (activeExactReads < MAX_CONCURRENT_EXACT_ROW_READS && queuedExactReads.size > 0) {
      const batch = new Map<string, ExactRowPreparation>();
      let store: string | undefined;
      // Coalesce the accepted FIFO prefix, keeping failures inside one physical store.
      for (const [id, read] of queuedExactReads) {
        if (batch.size === MAX_SESSION_ROW_FACTS_KEYS || (store && store !== read.store)) {
          break;
        }
        store = read.store;
        batch.set(id, read);
        queuedExactReads.delete(id);
      }
      activeExactReads++;
      void readExactBatch(batch);
    }
  }
  function pendingExactRows(queries: readonly records.Lookup[]) {
    const { cfg } = owner.state();
    const selected = new Set<string>();
    for (const query of queries) {
      const key = resolveStoredSessionKeyForAgentStore({
        cfg,
        sessionKey: query.key,
        agentId: query.agentId,
      });
      if (isIncognitoSessionKey(key)) {
        continue;
      }
      const row = owner.lookup(query);
      if (row && (owner.dirty.has(records.identity(row)) || isCold(row))) {
        selected.add(records.identity(row));
      }
    }
    return selected;
  }
  function prepareExactRows(queries: readonly records.Lookup[]): Promise<void> | undefined {
    if (owner.state().disposed) {
      return undefined;
    }
    const selected = pendingExactRows(queries);
    if (selected.size === 0) {
      return undefined;
    }
    const joined = new Set([...selected].flatMap((id) => bulkReads.get(id) ?? []));
    const missing = [...selected].filter((id) => !exactReads.has(id) && !bulkReads.has(id));
    const bytes = missing.reduce((total, id) => total + 6 * id.length + 3, 0);
    if (
      exactReads.size + missing.length >
        DEFAULT_WORKER_PENDING_TASKS * MAX_SESSION_ROW_FACTS_KEYS ||
      exactReadBytes + bytes > DEFAULT_WORKER_PENDING_BYTES
    ) {
      throw new WorkerTaskError("Session row preparation capacity reached", "overloaded");
    }
    for (const id of missing) {
      const row = owner.rows.get(id)!;
      const read: ExactRowPreparation = {
        completion: createDeferredCore(),
        store: `${row.storeTarget.agentId}\0${row.storeTarget.storePath}`,
        bytes: 6 * id.length + 3,
      };
      exactReads.set(id, read);
      queuedExactReads.set(id, read);
      exactReadBytes += read.bytes;
    }
    for (const id of selected) {
      if (!isCold(owner.rows.get(id)!)) {
        owner.dirty.add(id);
      }
    }
    queueMicrotask(dispatchExactReads);
    const exact = Promise.all(
      [...selected].flatMap((id) => exactReads.get(id)?.completion.promise ?? []),
    );
    if (joined.size === 0) {
      return exact.then(() => undefined);
    }
    // The bulk read may reject its facts; recheck the rows once it settles.
    return Promise.all([exact, ...joined]).then(() => prepareExactRows(queries));
  }
  function readRows(
    selected: ReadonlySet<string>,
    options: { archived?: boolean; materialize?: boolean } = {},
  ) {
    return withSessionRowDatabaseFacts(
      {
        rows: owner.rows,
        dirty: owner.dirty,
        selected,
        isActive: () => !owner.state().disposed,
        prepareRegistryFacts: owner.prepareRegistryFacts,
        cfg: owner.state().cfg,
        env: owner.env,
      },
      {
        refreshPending: options.materialize === false ? () => false : materializer.refreshPending,
        accept: (ids, facts) => materializer.accept(ids, facts, options),
      },
    );
  }
  function selectionNeedsPreparation() {
    const state = owner.state();
    if (state.disposed) {
      return false;
    }
    if (
      state.topologyDirty ||
      !state.registryPrepared ||
      owner.catalog.needsInitialRead ||
      owner.membership.needsPreparation
    ) {
      return true;
    }
    // Accepted database facts already own selection metadata, even while display is dirty.
    for (const id of owner.dirty) {
      const row = owner.rows.get(id);
      const facts = row?.retainedDatabaseFacts;
      if (
        !records.isPreparedSessionRowDatabaseFacts(facts) ||
        (!records.canRetainSessionRowRuntimeOwnership(facts) && !row?.pendingDatabaseFacts)
      ) {
        return true;
      }
    }
    return false;
  }
  function retainExactPreparation() {
    exactPreparations++;
    exactPreparationsIdle ??= createDeferredCore();
    let retained = true;
    return () => {
      if (!retained) {
        return;
      }
      retained = false;
      if (--exactPreparations === 0) {
        const idle = exactPreparationsIdle;
        exactPreparationsIdle = undefined;
        idle?.resolve();
      }
    };
  }
  function prepareSelection(yieldForCatalog = false): Promise<void> | undefined {
    if (!owner.state().disposed && !owner.catalog.needsInitialRead) {
      void owner.runAsOwner(() => owner.catalog.refresh());
    }
    if (yieldForCatalog && owner.catalog.isRefreshing) {
      // Adopt completed catalog publications without waiting for a pending renewal.
      return yieldSessionListWork().then(() => prepareSelection());
    }
    if (selectionPreparation) {
      return selectionPreparation;
    }
    if (!selectionNeedsPreparation()) {
      if (!owner.state().disposed) {
        owner.prepare();
      }
      return undefined;
    }
    const release = retainExactPreparation();
    // Lists share metadata readiness, then only their exact pages build display rows.
    selectionPreparation = owner.runAsOwner(async () => {
      try {
        while (selectionNeedsPreparation()) {
          for (
            let pending = owner.prepareRegistryFacts();
            pending;
            pending = owner.prepareRegistryFacts()
          ) {
            await pending;
          }
          if (owner.state().topologyDirty) {
            await owner.topology();
          }
          if (owner.state().disposed || owner.state().topologyDirty) {
            continue;
          }
          await owner.membership.prepare();
          if (owner.catalog.needsInitialRead) {
            await owner.catalog.refresh();
          }
          const selected = new Set<string>();
          const held = new Set<Promise<void>>();
          for (const id of owner.dirty) {
            if (
              records.isPreparedSessionRowDatabaseFacts(owner.rows.get(id)?.retainedDatabaseFacts)
            ) {
              continue;
            }
            const pending = bulkReads.get(id) ?? exactReads.get(id)?.completion.promise;
            if (pending) {
              held.add(pending);
            } else if (selected.add(id).size === MAX_SESSION_ROW_FACTS_KEYS) {
              break;
            }
          }
          if (selected.size > 0) {
            const read = createDeferredCore();
            for (const id of selected) {
              bulkReads.set(id, read.promise);
            }
            try {
              await readRows(selected, { materialize: false });
            } finally {
              for (const id of selected) {
                bulkReads.delete(id);
              }
              read.resolve();
            }
          } else {
            await Promise.all(held);
          }
        }
        if (!owner.state().disposed) {
          owner.prepare();
        }
      } finally {
        selectionPreparation = undefined;
        release();
      }
    });
    return selectionPreparation;
  }
  async function refreshBatch() {
    for (
      let pending = exactPreparationsIdle;
      pending && !owner.state().disposed;
      pending = exactPreparationsIdle
    ) {
      const state = owner.state();
      if (
        !state.topologyDirty &&
        state.registryPrepared &&
        !owner.catalog.needsInitialRead &&
        !owner.placementFacts.needsPreparation &&
        !owner.membership.needsPreparation
      ) {
        // Accepted exact facts need no worker read and may finish while their page remains pinned.
        const ids: string[] = [];
        for (const id of exactReads.keys()) {
          ids.push(id);
          if (ids.length === MAX_CONCURRENT_EXACT_ROW_READS * MAX_SESSION_ROW_FACTS_KEYS) {
            break;
          }
        }
        if (materializer.refreshPending(ids)) {
          return;
        }
      }
      await pending.promise;
    }
    for (
      let pending = owner.prepareRegistryFacts();
      pending;
      pending = owner.prepareRegistryFacts()
    ) {
      await pending;
    }
    if (owner.state().disposed) {
      return;
    }
    if (owner.state().topologyDirty) {
      await owner.topology();
      if (owner.state().disposed || owner.state().topologyDirty) {
        return;
      }
    }
    await owner.membership.prepare();
    if (owner.catalog.needsInitialRead) {
      await owner.catalog.refresh();
    }
    await owner.placementFacts.prepare();
    for (
      let pending = owner.prepareRegistryFacts();
      pending;
      pending = owner.prepareRegistryFacts()
    ) {
      await pending;
    }
    if (
      exactPreparations > 0 ||
      owner.state().topologyDirty ||
      owner.membership.needsPreparation ||
      owner.placementFacts.needsPreparation
    ) {
      return;
    }
    const selected = new Set<string>();
    const held = new Set<Promise<void>>();
    for (const id of owner.dirty) {
      const exact = exactReads.get(id);
      // Accepted facts finish without a worker read, even while their exact read settles.
      if (exact && !owner.rows.get(id)?.pendingDatabaseFacts) {
        held.add(exact.completion.promise);
      } else if (selected.add(id).size === MAX_SESSION_ROW_FACTS_KEYS) {
        break;
      }
    }
    const read = createDeferredCore();
    for (const id of selected) {
      bulkReads.set(id, read.promise);
    }
    try {
      await readRows(selected);
    } finally {
      for (const id of selected) {
        if (bulkReads.get(id) === read.promise) {
          bulkReads.delete(id);
        }
      }
      read.resolve();
    }
    if (selected.size === 0) {
      // Only exact-owned rows remain dirty; wait for them instead of spinning the drain.
      await Promise.allSettled(held);
      // Let exact callers install their held snapshots before preparing placements again.
      await yieldSessionListWork();
    }
  }
  return {
    refresh: materializer.refresh,
    refreshBatch(this: void) {
      return (refreshing ??= refreshBatch().finally(() => {
        refreshing = undefined;
      }));
    },
    prepareExactRows,
    prepareSelection,
    selectionNeedsPreparation,
    retainExactPreparation,
    async withSelectionPreparation<T>(this: void, consume: () => Promise<T>): Promise<T> {
      // Preserve page priority across search/placement awaits and metadata preparation.
      const release = retainExactPreparation();
      try {
        return await consume();
      } finally {
        release();
      }
    },
    dispose(this: void) {
      exactPreparationsIdle?.resolve();
      for (const [id, read] of queuedExactReads) {
        read.completion.reject(new Error("Session row projection is no longer active"));
        releaseExactRead(id, read);
      }
      queuedExactReads.clear();
    },
  };
}
