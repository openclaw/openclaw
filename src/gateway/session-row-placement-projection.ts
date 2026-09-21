import { AsyncLocalStorage } from "node:async_hooks";
import { withCanonicalSessionValidationDeferral } from "../config/sessions/session-canonical-validation-deferral.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import type { SessionRowPlacementFacts } from "./session-row-placement-projection.types.js";
import { withPreparedSessionRows, type SessionRowReadView } from "./session-row-prepared-read.js";
import type { Row, Lookup } from "./session-row-projection-record.js";
import type { WorkerSessionPlacementProjection } from "./worker-environments/placement-read-projection.types.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

/** Placement facts share the resident row lifecycle; private exact reads retain only their frame. */
export function createSessionRowPlacementProjection(
  reader: Pick<WorkerSessionPlacementStore, "readProjection"> | undefined,
) {
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const resident = new Map<string, SessionRowPlacementFacts>();
  const registered = new Set<string>();
  const dirty = new Set<string>();
  let exact: ReadonlyMap<string, SessionRowPlacementFacts> | undefined;
  let revision = 0;
  let disposed = false;
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
      revision++;
      registered.delete(id);
      dirty.delete(id);
      resident.delete(id);
    },
    invalidate(id?: string) {
      revision++;
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
      const captured = revision;
      const snapshot = await inOwnerContext(() => reader.readProjection(requested));
      if (disposed || revision !== captured) {
        return;
      }
      for (const id of requested) {
        resident.set(id, select(snapshot, id));
        dirty.delete(id);
      }
    },
    async withPrepared<T>(
      selectIds: () => readonly string[],
      consume: () => T,
    ): Promise<Awaited<T>> {
      while (true) {
        if (disposed) {
          break;
        }
        const ids = selectIds();
        const requested = missing(ids);
        if (!reader || requested.length === 0) {
          return await consume();
        }
        const captured = revision;
        const snapshot = await inOwnerContext(() => reader.readProjection(requested));
        if (disposed) {
          break;
        }
        if (revision !== captured) {
          continue;
        }
        const prepared = new Map(requested.map((id) => [id, select(snapshot, id)]));
        // Resolve the exact identity again after waiting; never use a replaced session's facts.
        if (selectIds().some((id) => !resident.has(id) && !prepared.has(id))) {
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
      }
      throw new Error("Session row projection is no longer active");
    },
    dispose() {
      disposed = true;
      resident.clear();
      registered.clear();
      dirty.clear();
    },
  };
  return owner;
}
