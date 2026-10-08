import { AsyncLocalStorage } from "node:async_hooks";
import { WorkerTaskError } from "@openclaw/worker-runtime";
import { withCanonicalSessionValidationDeferral } from "../config/sessions/session-canonical-validation-deferral.js";
import { captureIncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_WORKER_PENDING_BYTES,
  DEFAULT_WORKER_PENDING_TASKS,
} from "../infra/worker-task-capacity.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import type { SessionRowPlacementFacts } from "./session-row-placement-projection.types.js";
import {
  privateSessionRowReadKey,
  readPreparedSessionRows,
  type withPreparedSessionRows,
  type PreparedPrivateSessionRepository,
  type SessionRowReadView,
} from "./session-row-prepared-read.js";
import { withBoundIncognitoSessionRows } from "./session-row-projection-read.js";
import {
  createIncognitoSessionRow,
  isCurrentGeneration,
  type Row,
  type Lookup,
} from "./session-row-projection-record.js";
import type { WorkerSessionPlacementProjection } from "./worker-environments/placement-read-projection.types.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const MAX_CONCURRENT_PLACEMENT_READS = 2;
const MAX_COALESCED_PLACEMENT_IDS = 256;
const MAX_COALESCED_PLACEMENT_BYTES = 64 * 1024;
type PlacementReadKind = "resident" | "exact";
type PrivatePlacementTarget = Pick<Row, "storeTarget"> & { sessionId: string };
type PlacementReadBatch = {
  kind: PlacementReadKind;
  ids: Set<string>;
  privateSessions: Map<string, PrivatePlacementTarget>;
  inputBytes: number;
  stale: Set<string>;
  staleAll: boolean;
  started: boolean;
  settled: boolean;
  readers: number;
  snapshot?: WorkerSessionPlacementProjection;
  completion: Deferred<WorkerSessionPlacementProjection>;
};

/** Placement facts share the resident row lifecycle; private exact reads retain only their frame. */
export function createSessionRowPlacementProjection(
  reader: Pick<WorkerSessionPlacementStore, "readProjection"> | undefined,
  prepareReadFacts: () => Promise<void> | undefined,
  inputEnv: NodeJS.ProcessEnv = process.env,
) {
  const env = captureSessionTranscriptStorageEnvironment(inputEnv);
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const resident = new Map<string, SessionRowPlacementFacts>();
  const registered = new Set<string>();
  const dirty = new Set<string>();
  let exact: ReadonlyMap<string, SessionRowPlacementFacts> | undefined;
  let disposed = false;
  const activeReads = new Set<PlacementReadBatch>();
  const queuedReads: PlacementReadBatch[] = [];
  const reads = new Set<PlacementReadBatch>();
  let retainedInputBytes = 0;
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
    if (read.settled && read.readers === 0 && reads.delete(read)) {
      retainedInputBytes -= read.inputBytes;
    }
  };
  function dispatchQueuedReads() {
    while (queuedReads.length && activeReads.size < MAX_CONCURRENT_PLACEMENT_READS) {
      const batch = queuedReads.shift()!;
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
      batch.snapshot = await inOwnerContext(() => reader.readProjection([...batch.ids]));
      batch.completion.resolve(batch.snapshot);
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
  const acquireRead = (
    ids: readonly string[],
    kind: PlacementReadKind,
    privateSessions: ReadonlyMap<string, PrivatePlacementTarget> = new Map(),
  ) => {
    if (disposed) {
      throw new Error("Session row projection is no longer active");
    }
    const covers = (batch: PlacementReadBatch) =>
      batch.kind === kind &&
      !batch.staleAll &&
      ids.every((id) => batch.ids.has(id) && !batch.stale.has(id)) &&
      [...privateSessions].every(([key, target]) => {
        const previous = batch.privateSessions.get(key);
        return (
          previous?.sessionId === target.sessionId &&
          previous.storeTarget.agentId === target.storeTarget.agentId &&
          previous.storeTarget.storePath === target.storeTarget.storePath
        );
      });
    // Exact requests must not join broader resident preparation and wait for unrelated work.
    let read = [...activeReads].find(covers) ?? queuedReads.find(covers);
    let addedBytes = 0;
    if (!read) {
      const tail = queuedReads.at(-1);
      if (tail?.kind === kind && ids.length <= MAX_COALESCED_PLACEMENT_IDS) {
        let count = tail.ids.size;
        for (const id of ids) {
          if (!tail.ids.has(id)) {
            count++;
            // Upper-bound JSON escaping without allocating another copy of each ID.
            addedBytes += 6 * id.length + 3;
          }
        }
        if (
          count <= MAX_COALESCED_PLACEMENT_IDS &&
          tail.inputBytes + addedBytes <= MAX_COALESCED_PLACEMENT_BYTES
        ) {
          read = tail;
        }
      }
    }
    if (!read) {
      // A large caller keeps one snapshot. Capacity counts batches, never joined consumers.
      if (reads.size >= DEFAULT_WORKER_PENDING_TASKS) {
        throw new WorkerTaskError("Placement read capacity reached", "overloaded");
      }
      addedBytes = 2;
      for (const id of ids) {
        addedBytes += 6 * id.length + 3;
        if (retainedInputBytes + addedBytes > DEFAULT_WORKER_PENDING_BYTES) {
          throw new WorkerTaskError("Placement read capacity reached", "overloaded");
        }
      }
    }
    if (retainedInputBytes + addedBytes > DEFAULT_WORKER_PENDING_BYTES) {
      throw new WorkerTaskError("Placement read capacity reached", "overloaded");
    }
    if (!read) {
      const batch: PlacementReadBatch = {
        kind,
        ids: new Set(),
        privateSessions: new Map(),
        inputBytes: 0,
        stale: new Set(),
        staleAll: false,
        started: false,
        settled: false,
        readers: 0,
        completion: createDeferredCore<WorkerSessionPlacementProjection>(),
      };
      read = batch;
      queuedReads.push(batch);
      reads.add(batch);
      queueMicrotask(dispatchQueuedReads);
    }
    if (!read.started) {
      for (const id of ids) {
        read.ids.add(id);
      }
      for (const [key, id] of privateSessions) {
        read.privateSessions.set(key, id);
      }
      read.inputBytes += addedBytes;
      retainedInputBytes += addedBytes;
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
      workspaceRecoveryPending: snapshot.workspaceRecoveryPendingSessionIds.has(id),
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
      let prepared = exact?.get(id);
      if (!prepared) {
        // Row preparation can yield after its exact placement read has settled.
        for (const read of reads) {
          if (read.snapshot && !read.staleAll && read.ids.has(id) && !read.stale.has(id)) {
            prepared = select(read.snapshot, id);
            break;
          }
        }
      }
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
      if ("sessionKey" in change && change.scope === "acp") {
        return;
      }
      if ("sessionKey" in change) {
        for (const read of reads) {
          const target = read.privateSessions.get(change.sessionKey);
          if (
            target &&
            (!change.agentId || change.agentId === target.storeTarget.agentId) &&
            (!change.storePath || change.storePath === target.storeTarget.storePath)
          ) {
            invalidateReads(target.sessionId);
          }
        }
      }
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
        registered.has(row.entry.sessionId) &&
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
      projection: SessionRowReadView & {
        isCurrent(row: Row): boolean;
        getPolicyConfig(): OpenClawConfig;
      },
      isActive: () => boolean,
      lookup: (query: Lookup) => Row | undefined,
      queries: (config: OpenClawConfig) => readonly Lookup[],
      prepareRows: (queries: readonly Lookup[]) => Promise<void> | undefined,
      consume: (read: SessionRowReadView, queries: readonly Lookup[]) => T,
      prepareSelection?: () => Promise<void> | undefined,
    ): ReturnType<typeof withPreparedSessionRows<T>> {
      const signal = getAsyncWorkSignal();
      const binding = captureIncognitoSessionBinding();
      const assertActive = () => {
        signal?.throwIfAborted();
        if (disposed || !isActive()) {
          throw new Error("Session row projection is no longer active");
        }
      };
      const prepareFacts = () => prepareReadFacts() ?? prepareSelection?.();
      let deferred:
        | Extract<ReturnType<typeof withCanonicalSessionValidationDeferral>, { kind: "pending" }>
        | undefined;
      let preparedQueries: readonly Lookup[] = [];
      let selectedIds: readonly string[] = [];
      const privateTargets = new Map<string, PrivatePlacementTarget>();
      const privateRepositories = new Map<string, PreparedPrivateSessionRepository>();
      let privateSelections: Array<{ key: string; row: Row; workspaceId: string }> = [];
      let selectedConfig: OpenClawConfig | undefined;
      const selectRows = () => {
        const selected = withCanonicalSessionValidationDeferral(() => {
          const cfg = projection.state.cfg;
          if (selectedConfig !== cfg) {
            privateRepositories.clear();
            selectedConfig = cfg;
          }
          privateSelections = [];
          privateTargets.clear();
          preparedQueries = queries(cfg);
          const ids: string[] = [];
          for (const query of preparedQueries) {
            const key = privateSessionRowReadKey(cfg, query);
            const privateBinding =
              key && binding
                ? captureIncognitoSessionBinding({ ...query, sessionKey: query.key, env })
                : undefined;
            const entry = privateBinding?.actor.sessions.readSharing(query.key)?.entry;
            const row = privateBinding
              ? entry &&
                createIncognitoSessionRow({
                  cfg,
                  key: query.key,
                  agentId: query.agentId,
                  storePath: privateBinding.actor.path,
                  entry,
                  source: {
                    identity: privateBinding.actor.identity.incarnation,
                    assertCurrent: () => privateBinding.actor.assertReadable(),
                  },
                })
              : inOwnerContext(() => lookup(query));
            if (key && !privateBinding && row?.entry?.repositoryWorkspaceId) {
              privateSelections.push({ key, row, workspaceId: row.entry.repositoryWorkspaceId });
            }
            if (row?.entry) {
              ids.push(row.entry.sessionId);
              if (key) {
                privateTargets.set(row.key, {
                  sessionId: row.entry.sessionId,
                  storeTarget: row.storeTarget,
                });
              }
            }
          }
          return ids;
        }, env);
        deferred = selected.kind === "pending" ? selected : undefined;
        selectedIds = selected.kind === "complete" ? selected.value : [];
        if (privateRepositories.size) {
          const selectedPrivateKeys = new Set(privateSelections.map(({ key }) => key));
          for (const key of privateRepositories.keys()) {
            if (!selectedPrivateKeys.has(key)) {
              privateRepositories.delete(key);
            }
          }
        }
      };
      const prepareSelectedRows = () => {
        if (deferred) {
          return undefined;
        }
        let pending: Promise<void> | undefined;
        const prepared = withCanonicalSessionValidationDeferral(() => {
          pending = inOwnerContext(() => prepareRows(preparedQueries));
          if (pending) {
            return;
          }
          for (const { key, row, workspaceId } of privateSelections) {
            const existing = privateRepositories.get(key);
            if (existing?.workspaceId === workspaceId && isCurrentGeneration(existing.row, row)) {
              continue;
            }
            const cfg = selectedConfig;
            pending = inOwnerContext(async () => {
              const repository = await getSessionRepositoryWorkspaceStore().prepare(workspaceId);
              assertActive();
              if (projection.state.cfg === cfg) {
                privateRepositories.set(key, { row, workspaceId, repository });
              }
            });
            break;
          }
        }, env);
        deferred = prepared.kind === "pending" ? prepared : undefined;
        return pending;
      };
      const stalePrivatePreparation = Symbol("stale-private-row-preparation");
      const consumeRows = (
        placement?: ReadonlyMap<string, SessionRowPlacementFacts>,
        placementCurrent: () => boolean = () => true,
      ) => {
        if (deferred) {
          return Promise.resolve(deferred);
        }
        const cfg = projection.state.cfg;
        const consumePrepared = (
          privateRows?: ReadonlyMap<string, Row | undefined>,
        ): ReturnType<typeof readPreparedSessionRows<T>> | typeof stalePrivatePreparation => {
          assertActive();
          const privateIds = privateRows
            ? [...privateRows.values()].flatMap((row) => (row?.entry ? [row.entry.sessionId] : []))
            : [];
          if (
            !placementCurrent() ||
            projection.state.cfg !== cfg ||
            missing(privateIds).some((id) => !placement?.has(id))
          ) {
            return stalePrivatePreparation;
          }
          const previous = exact;
          if (placement) {
            exact = placement;
          }
          try {
            return readPreparedSessionRows(
              projection,
              isActive,
              () => preparedQueries,
              (read) => consume(read, preparedQueries),
              privateRepositories,
              privateRows,
              env,
            );
          } finally {
            exact = previous;
          }
        };
        return binding
          ? withBoundIncognitoSessionRows(cfg, preparedQueries, consumePrepared, env)
          : consumePrepared();
      };
      const prepare = () => {
        const pending = prepareFacts();
        if (pending) {
          return pending;
        }
        selectRows();
        return prepareSelectedRows();
      };
      const assertPublicationCurrent = (placementCurrent = true) => {
        // Only actor-backed preparation retains resources past the synchronous consumer.
        if (!binding) {
          return;
        }
        assertActive();
        if (!placementCurrent || projection.state.cfg !== selectedConfig) {
          throw new Error("Session row facts changed during cleanup");
        }
      };
      while (true) {
        assertActive();
        for (let pending = prepareFacts(); pending; pending = prepareFacts()) {
          await pending;
          assertActive();
        }
        selectRows();
        const requested = missing(selectedIds);
        if (!reader || requested.length === 0) {
          const pending = prepareSelectedRows();
          if (pending) {
            await pending;
            continue;
          }
          const result = await consumeRows();
          if (result === stalePrivatePreparation) {
            continue;
          }
          assertPublicationCurrent();
          return result;
        }
        const read = acquireRead(requested, "exact", privateTargets);
        try {
          const snapshot = await read.result;
          assertActive();
          // Caller facts can retire while the placement read yields.
          for (let pending = prepare(); pending; pending = prepare()) {
            await pending;
            assertActive();
          }
          const prepared = new Map(requested.map((id) => [id, select(snapshot, id)]));
          if (
            requested.some((id) => !read.isCurrent(id)) ||
            selectedIds.some((id) => !resident.has(id) && !prepared.has(id))
          ) {
            continue;
          }
          for (const [id, facts] of prepared) {
            if (registered.has(id)) {
              resident.set(id, facts);
              dirty.delete(id);
            }
          }
          const result = await consumeRows(prepared, () =>
            requested.every((id) => read.isCurrent(id)),
          );
          if (result === stalePrivatePreparation) {
            continue;
          }
          assertPublicationCurrent(requested.every((id) => read.isCurrent(id)));
          return result;
        } finally {
          read.release();
        }
      }
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
    dispose() {
      disposed = true;
      invalidateReads();
      for (const read of queuedReads) {
        read.settled = true;
        read.completion.reject(new Error("Session row projection is no longer active"));
        releaseRead(read);
      }
      queuedReads.length = 0;
      resident.clear();
      registered.clear();
      dirty.clear();
    },
  };
  return owner;
}
