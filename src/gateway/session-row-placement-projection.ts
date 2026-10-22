import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { WorkerTaskError } from "@openclaw/worker-runtime";
import {
  getSessionActorStorageBinding,
  captureSessionActorStorageOwner,
} from "../config/sessions/session-actor-storage-binding.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getMainThreadTaskName, runWithMainThreadTask } from "../infra/main-thread-stall.js";
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
const READS_PER_TURN = 8;
const READ_BUDGET_MS = 6;
type PlacementReadKind = "resident" | "exact";
type PlacementReadBatch = {
  kind: PlacementReadKind;
  ids: Set<string>;
  inputBytes: number;
  started: boolean;
  settled: boolean;
  readers: number;
  snapshot?: WorkerSessionPlacementProjection;
  completion: Deferred<WorkerSessionPlacementProjection>;
};

/** Placement facts share the resident row lifecycle; private exact reads retain only their frame. */
export function createSessionRowPlacementProjection(
  reader:
    | (Pick<WorkerSessionPlacementStore, "readProjection"> &
        Partial<Pick<WorkerSessionPlacementStore, "readPublishedProjection">>)
    | undefined,
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
  let started = 0;
  let startedAt = 0;
  let reset: ReturnType<typeof setImmediate> | undefined;
  let wake: ReturnType<typeof setImmediate> | undefined;
  const waiting = new Set<() => void>();
  function wakeNext() {
    wake ??= setImmediate(() => {
      wake = undefined;
      clearImmediate(reset);
      reset = undefined;
      const resume = waiting.values().next().value;
      if (resume) {
        waiting.delete(resume);
        resume();
      }
      if (waiting.size > 0) {
        wakeNext();
      }
    });
  }
  function claimTurn(resumed: boolean) {
    const now = performance.now();
    if (!reset) {
      started = 0;
      startedAt = now;
      reset = setImmediate(() => {
        reset = undefined;
      });
      reset.unref?.();
    }
    if (
      (!resumed && (wake || waiting.size > 0)) ||
      started >= READS_PER_TURN ||
      now - startedAt >= READ_BUDGET_MS
    ) {
      return new Promise<void>((resolve) => {
        waiting.add(resolve);
        wakeNext();
      });
    }
    started++;
    return undefined;
  }
  const activeReads = new Set<PlacementReadBatch>();
  const queuedReads: PlacementReadBatch[] = [];
  const reads = new Set<PlacementReadBatch>();
  const retireStartedReads = (id?: string) => {
    for (const read of reads) {
      // Dispatched reads may settle with an older snapshot; queued reads have not captured one.
      if (read.started) {
        if (id) {
          read.ids.delete(id);
        } else {
          read.ids.clear();
        }
      }
    }
  };
  let retainedInputBytes = 0;
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
      // Physical settlement frees capacity before consumers release their input reservations.
      dispatchQueuedReads();
    }
  }
  const acquireRead = (ids: readonly string[], kind: PlacementReadKind) => {
    if (disposed) {
      throw new Error("Session row projection is no longer active");
    }
    const covers = (batch: PlacementReadBatch) =>
      batch.kind === kind && ids.every((id) => batch.ids.has(id));
    // Exact requests must not join broader resident preparation and wait for unrelated work.
    // Later turns can join successful snapshots still held by overlapping row preparation.
    let read = [...reads].find((batch) => (!batch.settled || batch.snapshot) && covers(batch));
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
        inputBytes: 0,
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
      read.inputBytes += addedBytes;
      retainedInputBytes += addedBytes;
    }
    read.readers++;
    return {
      result: read.completion.promise,
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
    getProjectionFacts: (id: string) => resident.get(id) ?? exact?.get(id),
    isPrepared: (id: string) => !reader || exact?.has(id) === true || resident.has(id),
    get needsPreparation() {
      return (
        !disposed &&
        (dirty.size > 0 || [...reads].some((read) => read.kind === "resident" && !read.settled))
      );
    },
    register(id: string) {
      if (!reader || registered.has(id)) {
        return;
      }
      registered.add(id);
      let prepared = resident.get(id) ?? exact?.get(id);
      if (!prepared) {
        // Row preparation can yield after its exact placement read has settled.
        for (const read of reads) {
          if (read.snapshot && read.ids.has(id)) {
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
      retireStartedReads(id);
      registered.delete(id);
      dirty.delete(id);
      resident.delete(id);
    },
    publish(id: string, change: SessionRowChange): boolean {
      const published = reader?.readPublishedProjection?.(change);
      if (!published?.placements.has(id) || !registered.has(id)) {
        return false;
      }
      retireStartedReads(id);
      resident.set(id, select(published, id));
      dirty.delete(id);
      return true;
    },
    invalidate(id?: string) {
      retireStartedReads(id);
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
    ): Promise<T> {
      const task = `${getMainThreadTaskName() ?? "gateway"}:session-rows`;
      const signal = getAsyncWorkSignal();
      const memory = getSessionActorStorageBinding({});
      const assertActive = () => {
        signal?.throwIfAborted();
        if (disposed || !isActive()) {
          throw new Error("Session row projection is no longer active");
        }
      };
      const prepareFacts = () => prepareReadFacts() ?? prepareSelection?.();
      let preparedQueries: readonly Lookup[] = [];
      let privateQueries: Lookup[] = [];
      let selectedIds: readonly string[] = [];
      const privateRepositories = new Map<string, PreparedPrivateSessionRepository>();
      let privateSelections: Array<{ key: string; row: Row; workspaceId: string }> = [];
      let selectedConfig: OpenClawConfig | undefined;
      const selectRows = () =>
        runWithMainThreadTask(`${task}:select`, () => {
          const cfg = projection.state.cfg;
          if (selectedConfig !== cfg) {
            privateRepositories.clear();
            selectedConfig = cfg;
          }
          privateSelections = [];
          preparedQueries = queries(cfg);
          privateQueries = [];
          const ids: string[] = [];
          for (const query of preparedQueries) {
            const key = privateSessionRowReadKey(cfg, query);
            if (key) {
              privateQueries.push(query);
            }
            const privateMemory = key
              ? captureSessionActorStorageOwner(
                  { ...query, sessionKey: query.key, sessionActor: memory, env },
                  { assertCurrent: assertActive, authorize: assertActive },
                )
              : undefined;
            const snapshot = privateMemory?.owner?.readSession(query.key, privateMemory.authority);
            const assertSessionCurrent = privateMemory?.owner?.captureSessionReadGuard(query.key);
            const row = privateMemory
              ? snapshot?.entry &&
                createIncognitoSessionRow({
                  cfg,
                  key: query.key,
                  agentId: query.agentId,
                  storePath: privateMemory.path,
                  entry: snapshot.entry,
                  membership: new Set(snapshot.members.map((member) => member.identityId)),
                  source: {
                    identity: snapshot.version.epoch,
                    assertCurrent() {
                      assertActive();
                      assertSessionCurrent?.();
                      privateMemory.authority.assertCurrent();
                    },
                  },
                })
              : inOwnerContext(() => lookup(query));
            if (key && row?.entry?.repositoryWorkspaceId) {
              privateSelections.push({ key, row, workspaceId: row.entry.repositoryWorkspaceId });
            }
            if (row?.entry) {
              ids.push(row.entry.sessionId);
            }
          }
          selectedIds = ids;
          if (privateRepositories.size) {
            const selectedPrivateKeys = new Set(privateSelections.map(({ key }) => key));
            for (const key of privateRepositories.keys()) {
              if (!selectedPrivateKeys.has(key)) {
                privateRepositories.delete(key);
              }
            }
          }
        });
      const prepareSelectedRows = () =>
        runWithMainThreadTask(`${task}:prepare`, () => {
          let pending = inOwnerContext(() => prepareRows(preparedQueries));
          if (pending) {
            return pending;
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
          return pending;
        });
      const stalePrivatePreparation = Symbol("stale-private-row-preparation");
      let privateResumed = false;
      const consumeRows = (placement?: ReadonlyMap<string, SessionRowPlacementFacts>) => {
        const cfg = projection.state.cfg;
        let privateTurn: Promise<void> | undefined;
        const consumePrepared = (
          privateRows?: ReadonlyMap<string, Row | undefined>,
        ): ReturnType<typeof readPreparedSessionRows<T>> | typeof stalePrivatePreparation =>
          runWithMainThreadTask(`${task}:consume`, () => {
            assertActive();
            if (privateRows && !privateResumed && (privateTurn = claimTurn(true))) {
              return stalePrivatePreparation;
            }
            // A granted retry must finish even if preparing its private frame exceeds the budget.
            privateResumed = false;
            const privateIds = privateRows
              ? [...privateRows.values()].flatMap((row) =>
                  row?.entry ? [row.entry.sessionId] : [],
                )
              : [];
            if (
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
                () => privateQueries,
                (read) => consume(read, preparedQueries),
                privateRepositories,
                privateRows,
              );
            } finally {
              exact = previous;
            }
          });
        return privateQueries.length > 0
          ? withBoundIncognitoSessionRows(cfg, privateQueries, consumePrepared, env).then(
              async (result) => {
                if (privateTurn) {
                  await privateTurn;
                  resumed = true;
                  privateResumed = true;
                }
                return result;
              },
            )
          : consumePrepared();
      };
      let resumed = false;
      const prepareSelectionFrame = () => {
        const pending = prepareFacts();
        if (pending) {
          return pending;
        }
        // Admit before selection: ready bursts yield without discarding and rebuilding a view.
        const turn = claimTurn(resumed);
        resumed = false;
        if (turn) {
          return turn.then(() => {
            resumed = true;
          });
        }
        selectRows();
        return undefined;
      };
      const prepare = () => prepareSelectionFrame() ?? prepareSelectedRows();
      const assertPublicationCurrent = () => {
        // Only actor-backed preparation retains resources past the synchronous consumer.
        if (privateQueries.length === 0) {
          return;
        }
        assertActive();
        if (projection.state.cfg !== selectedConfig) {
          throw new Error("Session row facts changed during cleanup");
        }
      };
      while (true) {
        assertActive();
        for (let pending = prepareSelectionFrame(); pending; pending = prepareSelectionFrame()) {
          await pending;
          assertActive();
        }
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
        const read = acquireRead(requested, "exact");
        try {
          const snapshot = await read.result;
          assertActive();
          // Caller facts can retire while the placement read yields.
          for (let pending = prepare(); pending; pending = prepare()) {
            await pending;
            assertActive();
          }
          const prepared = new Map(
            requested.map((id) => [id, resident.get(id) ?? select(snapshot, id)]),
          );
          if (selectedIds.some((id) => !resident.has(id) && !prepared.has(id))) {
            continue;
          }
          for (const [id, facts] of prepared) {
            if (registered.has(id)) {
              resident.set(id, facts);
              dirty.delete(id);
            }
          }
          const result = await consumeRows(prepared);
          if (result === stalePrivatePreparation) {
            continue;
          }
          assertPublicationCurrent();
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
        // Dequeue this batch; invalidations during its read remain queued for the next pass.
        for (const id of requested) {
          dirty.delete(id);
        }
        const snapshot = await read.result;
        if (disposed) {
          return;
        }
        for (const id of requested) {
          if (registered.has(id) && !dirty.has(id)) {
            resident.set(id, resident.get(id) ?? select(snapshot, id));
          }
        }
      } catch (error) {
        for (const id of requested) {
          if (registered.has(id)) {
            dirty.add(id);
          }
        }
        throw error;
      } finally {
        read.release();
      }
    },
    dispose() {
      disposed = true;
      clearImmediate(reset);
      clearImmediate(wake);
      for (const resume of waiting) {
        resume();
      }
      waiting.clear();
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
