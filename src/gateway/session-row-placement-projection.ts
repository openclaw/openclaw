import { AsyncLocalStorage } from "node:async_hooks";
import { withCanonicalSessionValidationDeferral } from "../config/sessions/session-canonical-validation-deferral.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import type { SessionRowPlacementFacts } from "./session-row-placement-projection.types.js";
import { withPreparedSessionRows, type SessionRowReadView } from "./session-row-prepared-read.js";
import type { Row, Lookup } from "./session-row-projection-record.js";
import type { WorkerSessionPlacementProjection } from "./worker-environments/placement-read-projection.types.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const MAX_CONCURRENT_PLACEMENT_READS = 2;
type PlacementReadKind = "resident" | "exact";
type PlacementReadBatch = {
  kind: PlacementReadKind;
  ids: Set<string>;
  stale: Set<string>;
  staleAll: boolean;
  started: boolean;
  settled: boolean;
  readers: number;
  completion: Deferred<WorkerSessionPlacementProjection>;
};

/** Placement facts share the resident row lifecycle; private exact reads retain only their frame. */
export function createSessionRowPlacementProjection(
  reader: Pick<WorkerSessionPlacementStore, "readProjection"> | undefined,
  prepareReadFacts: () => Promise<void> | undefined,
) {
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const resident = new Map<string, SessionRowPlacementFacts>();
  const registered = new Set<string>();
  const dirty = new Set<string>();
  let exact: ReadonlyMap<string, SessionRowPlacementFacts> | undefined;
  let disposed = false;
  const activeReads = new Set<PlacementReadBatch>();
  const queuedReads = new Map<PlacementReadKind, PlacementReadBatch>();
  const reads = new Set<PlacementReadBatch>();
  const invalidateReads = (id?: string) => {
    for (const read of reads) {
      // Queued reads capture state when dispatched, after these publications.
      if (!read.started) {
        continue;
      }
      if (id === undefined) {
        read.staleAll = true;
      } else if (read.ids.has(id)) {
        read.stale.add(id);
      }
    }
  };
  const releaseRead = (read: PlacementReadBatch) => {
    if (read.settled && read.readers === 0) {
      reads.delete(read);
    }
  };
  function dispatchQueuedReads() {
    for (const batch of queuedReads.values()) {
      if (activeReads.size >= MAX_CONCURRENT_PLACEMENT_READS) {
        break;
      }
      queuedReads.delete(batch.kind);
      batch.started = true;
      activeReads.add(batch);
      void runRead(batch);
    }
  }
  async function runRead(batch: PlacementReadBatch) {
    try {
      if (disposed || !reader) {
        throw new Error("Session row projection is no longer active");
      }
      batch.completion.resolve(await inOwnerContext(() => reader.readProjection([...batch.ids])));
    } catch (error) {
      batch.completion.reject(error);
    } finally {
      batch.settled = true;
      activeReads.delete(batch);
      releaseRead(batch);
      // Physical settlement frees capacity before consumers release their freshness leases.
      dispatchQueuedReads();
    }
  }
  const acquireRead = (ids: readonly string[], kind: PlacementReadKind) => {
    // Exact requests must not join broader resident preparation and wait for unrelated work.
    let read =
      [...activeReads].find(
        (active) =>
          active.kind === kind &&
          !active.staleAll &&
          ids.every((id) => active.ids.has(id) && !active.stale.has(id)),
      ) ?? queuedReads.get(kind);
    if (!read) {
      const batch: PlacementReadBatch = {
        kind,
        ids: new Set(),
        stale: new Set(),
        staleAll: false,
        started: false,
        settled: false,
        readers: 0,
        completion: createDeferredCore<WorkerSessionPlacementProjection>(),
      };
      read = batch;
      queuedReads.set(kind, batch);
      reads.add(batch);
      queueMicrotask(dispatchQueuedReads);
    }
    if (!read.started) {
      for (const id of ids) {
        read.ids.add(id);
      }
    }
    read.readers++;
    return {
      result: read.completion.promise,
      isCurrent: (id: string) => read.ids.has(id) && !read.staleAll && !read.stale.has(id),
      release() {
        read.readers--;
        releaseRead(read);
      },
    };
  };
  const select = (
    snapshot: WorkerSessionPlacementProjection,
    id: string,
  ): SessionRowPlacementFacts => {
    const placement = snapshot.placements.get(id);
    return {
      placement,
      move: snapshot.moves.get(id),
      environment: placement?.environmentId
        ? snapshot.environments.get(placement.environmentId)
        : undefined,
      workspaceResultReconciling: snapshot.workspaceResultReconcilingSessionIds.has(id),
    };
  };
  const missing = (ids: readonly string[]) =>
    reader ? [...new Set(ids)].filter((id) => !resident.has(id)) : [];
  const owner = {
    getProjectionFacts: (id: string) => exact?.get(id) ?? resident.get(id),
    isPrepared: (id: string) => !reader || exact?.has(id) === true || resident.has(id),
    get needsPreparation() {
      return !disposed && dirty.size > 0;
    },
    register(id: string) {
      if (!reader || registered.has(id)) {
        return;
      }
      registered.add(id);
      const prepared = exact?.get(id);
      if (prepared) {
        resident.set(id, prepared);
      } else {
        dirty.add(id);
      }
    },
    forget(id: string) {
      invalidateReads(id);
      registered.delete(id);
      dirty.delete(id);
      resident.delete(id);
    },
    invalidate(id?: string) {
      invalidateReads(id);
      if (id) {
        resident.delete(id);
        if (registered.has(id)) {
          dirty.add(id);
        }
      } else {
        resident.clear();
        for (const registeredId of registered) {
          dirty.add(registeredId);
        }
      }
    },
    invalidateChange(change: SessionRowChange) {
      if (
        "all" in change &&
        (change.scope === "worker-placements" ||
          change.scope === "worker-environments" ||
          change.scope === "stores")
      ) {
        owner.invalidate();
      }
    },
    update(row: Row, previous: Row | undefined, related: (id: string) => Row[]) {
      if (row.entry && (row.entry.archivedAt === undefined || row.materialized)) {
        owner.register(row.entry.sessionId);
      } else if (
        row.entry &&
        !related(row.entry.sessionId).some(
          (other) => other.entry && (other.entry.archivedAt === undefined || other.materialized),
        )
      ) {
        owner.forget(row.entry.sessionId);
      }
      if (
        previous?.entry &&
        previous.entry.sessionId !== row.entry?.sessionId &&
        related(previous.entry.sessionId).length === 0
      ) {
        owner.forget(previous.entry.sessionId);
      }
    },
    async withPreparedRows<T>(
      projection: SessionRowReadView & { isCurrent(row: Row): boolean },
      isActive: () => boolean,
      lookup: (query: Lookup) => Row | undefined,
      queries: (config: OpenClawConfig) => readonly Lookup[],
      consume: (read: SessionRowReadView) => T,
    ): ReturnType<typeof withPreparedSessionRows<T>> {
      let deferred: { kind: "pending"; database: { agentId: string; path: string } } | undefined;
      let preparedQueries: readonly Lookup[] = [];
      return owner.withPrepared(
        () => {
          const selected = withCanonicalSessionValidationDeferral(() => {
            preparedQueries = queries(projection.state.cfg);
            return preparedQueries.flatMap((query) => {
              const row = inOwnerContext(() => lookup(query));
              return row?.entry ? [row.entry.sessionId] : [];
            });
          });
          deferred = selected.kind === "pending" ? selected : undefined;
          return selected.kind === "complete" ? selected.value : [];
        },
        () =>
          deferred ?? withPreparedSessionRows(projection, isActive, () => preparedQueries, consume),
      );
    },
    async prepare() {
      const requested = [...dirty];
      if (disposed || !reader || requested.length === 0) {
        return;
      }
      const read = acquireRead(requested, "resident");
      try {
        const snapshot = await read.result;
        if (disposed) {
          return;
        }
        for (const id of requested) {
          if (registered.has(id) && read.isCurrent(id)) {
            resident.set(id, select(snapshot, id));
            dirty.delete(id);
          }
        }
      } finally {
        read.release();
      }
    },
    async withPrepared<T>(
      selectIds: () => readonly string[],
      consume: () => T,
    ): Promise<Awaited<T>> {
      while (true) {
        for (let pending = prepareReadFacts(); pending; pending = prepareReadFacts()) {
          await pending;
        }
        if (disposed) {
          break;
        }
        const ids = selectIds();
        const requested = missing(ids);
        if (!reader || requested.length === 0) {
          return await consume();
        }
        const read = acquireRead(requested, "exact");
        try {
          const snapshot = await read.result;
          // Caller facts can retire while the placement read yields.
          for (let pending = prepareReadFacts(); pending; pending = prepareReadFacts()) {
            await pending;
          }
          if (disposed) {
            break;
          }
          const prepared = new Map(requested.map((id) => [id, select(snapshot, id)]));
          // Resolve the exact identity again after waiting; never use a replaced session's facts.
          const selectedIds = selectIds();
          if (
            requested.some((id) => !read.isCurrent(id)) ||
            selectedIds.some((id) => !resident.has(id) && !prepared.has(id))
          ) {
            continue;
          }
          const previous = exact;
          let result: T;
          // Owner context restoration must retain this synchronous frame, never its async descendants.
          exact = prepared;
          try {
            result = consume();
          } finally {
            exact = previous;
            prepared.clear();
          }
          return await result;
        } finally {
          read.release();
        }
      }
      throw new Error("Session row projection is no longer active");
    },
    dispose() {
      disposed = true;
      invalidateReads();
      for (const read of queuedReads.values()) {
        read.settled = true;
        read.completion.reject(new Error("Session row projection is no longer active"));
        releaseRead(read);
      }
      queuedReads.clear();
      resident.clear();
      registered.clear();
      dirty.clear();
    },
  };
  return owner;
}
