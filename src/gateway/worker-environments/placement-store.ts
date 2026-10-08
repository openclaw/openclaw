import { randomUUID } from "node:crypto";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { startWorkerPlacementDispatch } from "./placement-dispatch-store.js";
import { createPlacementLifecycleWorkerOps } from "./placement-lifecycle-store.js";
import { createPlacementMoveOps } from "./placement-move-intent.js";
import type { WorkerSessionPlacementProjection } from "./placement-read-projection.types.js";
import { createPlacementReadStore } from "./placement-read-store.js";
import {
  normalizeEpoch,
  required,
  type WorkerSessionPlacementDispatchIdentity,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import {
  retireWorkerSessionPlacement,
  type WorkerSessionPlacementRetirement,
} from "./placement-retirement.js";
import {
  find,
  fromRow,
  query,
  readWorkerPlacementsForReconcileInDatabase,
} from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import { createPlacementSessionToolOperationOps } from "./placement-session-tool-operations.js";
import {
  observePlacementAuthority,
  preparePlacementAuthorityRead,
  preparePlacementTurnClaimAuthority,
  type PlacementTurnClaimAuthority,
} from "./placement-turn-authority.js";
import { attachWorkerTurnExecutionIdentityStore } from "./placement-turn-claim-events.js";
import { createPlacementTurnClaimWorkerOps } from "./placement-turn-claims-store.js";
import {
  createPlacementTurnClaimOps,
  registerWorkerTurnClaimClosedHandler,
} from "./placement-turn-claims.js";
import { createPlacementWorkspaceJournalWorkerOps } from "./placement-workspace-journal-store.js";
import { createPlacementWorkspaceReservationOps } from "./placement-workspace-reservation.js";
import { createPlacementWorkspaceResultReader } from "./placement-workspace-result-store.js";
import {
  projectWorkspaceResultConflict,
  type WorkerWorkspaceResultConflict,
} from "./workspace-conflicts.js";

export type { WorkerSessionPlacementRetirement } from "./placement-retirement.js";

function exactConflictPath(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Worker placement conflict path is required");
  }
  return value;
}

export type { WorkerSessionPlacementRecord, WorkerSessionTurnClaim } from "./placement-record.js";

export function createWorkerSessionPlacementStore(
  options: { database?: OpenClawStateDatabase; now?: () => number } = {},
) {
  const path = (options.database ?? openOpenClawStateDatabase()).path;
  const now = options.now ?? Date.now;
  const context = captureOpenClawStateWorkerContext({ path });
  const runtime: PlacementStoreRuntime = {
    path,
    instanceId: randomUUID(),
    now,
    read: () => {
      context.admission.assertCurrent();
      return openOpenClawStateDatabase({ path }).db;
    },
    write: (operation) => runOpenClawStateWriteTransaction(({ db }) => operation(db), { path }),
  };
  const { read, write } = runtime;
  const { clearLocalTurnClaimsAfterRestart, waitForTurnClaimRelease, validateTurnClaim } =
    createPlacementTurnClaimOps(runtime);
  const workspaceResultConflicts = new Map<
    string,
    {
      conflict: WorkerWorkspaceResultConflict;
      placement: WorkerSessionPlacementRecord;
      claim: WorkerSessionTurnClaim;
    }
  >();
  const withWorkspaceResultConflict = (
    record: WorkerSessionPlacementRecord | undefined,
  ): WorkerSessionPlacementRecord | undefined => {
    if (!record) {
      return undefined;
    }
    const conflict = workspaceResultConflicts.get(record.sessionId)?.conflict;
    return conflict ? { ...record, workspaceResultConflict: conflict } : record;
  };

  const store = {
    ...createPlacementReadStore({ path, withWorkspaceResultConflict }),
    ...createPlacementWorkspaceReservationOps(runtime),
    clearLocalTurnClaimsAfterRestart,
    waitForTurnClaimRelease,
    validateTurnClaim,
    ...createPlacementSessionToolOperationOps({
      path,
      instanceId: runtime.instanceId,
      now: options.now,
    }),
    ...createPlacementTurnClaimWorkerOps({
      path,
      instanceId: runtime.instanceId,
      now: options.now,
    }),
    getPlacementMove: createPlacementMoveOps(runtime).getPlacementMove,
    ...createPlacementLifecycleWorkerOps({
      path,
      now: options.now,
      onRetired: (sessionId) => workspaceResultConflicts.delete(sessionId),
    }),
    ...createPlacementWorkspaceJournalWorkerOps({ path, now: options.now }),
    ...createPlacementWorkspaceResultReader(
      runtime,
      (ids): Promise<WorkerSessionPlacementProjection> =>
        store.readProjection(ids, { current: true }),
    ),

    registerTurnClaimClosedHandler(handler: (claim: WorkerSessionTurnClaim) => void): () => void {
      return registerWorkerTurnClaimClosedHandler(path, handler);
    },

    get(sessionId: string): WorkerSessionPlacementRecord | undefined {
      return withWorkspaceResultConflict(find(read(), required(sessionId, "session id")));
    },

    prepareTurnClaimAuthority(claim: WorkerSessionTurnClaim): Promise<PlacementTurnClaimAuthority> {
      return preparePlacementTurnClaimAuthority(path, claim, (sessionIds) =>
        store.readProjection(sessionIds, { current: true }),
      );
    },

    async prepareRuntimeRefresh(sessionIdInput: string) {
      const sessionId = required(sessionIdInput, "session id");
      const { value: projection, ...observation } = await preparePlacementAuthorityRead(
        path,
        sessionId,
        () => store.readProjection([sessionId], { current: true }),
      );
      return {
        placement: projection.placements.get(sessionId),
        move: projection.moves.get(sessionId),
        pendingResult: projection.pendingResults.get(sessionId),
        ...observation,
      };
    },

    async prepareMaintenancePlacements() {
      const observation = observePlacementAuthority(path);
      try {
        const result = await executeExistingOpenClawStateRead(
          { path },
          { type: "workers.placementPreservation" },
          { current: true },
        );
        observation.assertCurrent();
        if (!result || !result.ok || result.type !== "workers.placementPreservation") {
          throw new Error("Worker placement preservation source is unavailable");
        }
        return { placements: result.placements, ...observation };
      } catch (error) {
        observation.release();
        throw error;
      }
    },

    async readProjection(
      sessionIds: readonly string[],
      readOptions: { current?: boolean } = {},
    ): Promise<WorkerSessionPlacementProjection> {
      const requestedIds = new Map(sessionIds.map((id) => [id, required(id, "session id")]));
      const ids = [...new Set(requestedIds.values())];
      const conflicts = new Map(
        ids.flatMap((id) => {
          const conflict = workspaceResultConflicts.get(id);
          return conflict ? [[id, conflict] as const] : [];
        }),
      );
      const result = await executeExistingOpenClawStateRead(
        { path },
        {
          type: "workers.placementProjection",
          sessionIds: ids,
          conflictBindings: [...conflicts.values()].map(({ placement, claim }) => ({
            placement: {
              sessionId: placement.sessionId,
              generation: placement.generation,
              environmentId: placement.environmentId,
              activeOwnerEpoch: placement.activeOwnerEpoch,
            },
            claim: { ...claim },
          })),
        },
        readOptions,
      );
      if (!result || !result.ok || result.type !== "workers.placementProjection") {
        throw new Error("Worker placement projection source is unavailable");
      }
      const { projection, conflictSessionIds } = result.result;
      const placements = new Map(projection.placements);
      for (const [id, captured] of conflicts) {
        const record = placements.get(id);
        if (record && conflictSessionIds.has(id) && workspaceResultConflicts.get(id) === captured) {
          placements.set(id, { ...record, workspaceResultConflict: captured.conflict });
        }
      }
      const byRequestedId = <T>(records: ReadonlyMap<string, T>) => {
        const requested = new Map<string, T>();
        for (const [original, normalized] of requestedIds) {
          const value = records.get(normalized);
          if (value !== undefined) {
            requested.set(original, value);
          }
        }
        return requested;
      };
      const byRequestedSet = (normalizedSessionIds: ReadonlySet<string>) =>
        new Set(
          [...requestedIds].flatMap(([original, normalized]) =>
            normalizedSessionIds.has(normalized) ? [original] : [],
          ),
        );
      return {
        ...projection,
        placements: byRequestedId(placements),
        moves: byRequestedId(projection.moves),
        pendingResults: byRequestedId(projection.pendingResults),
        workspaceJournalOwnerSessionIds: byRequestedSet(projection.workspaceJournalOwnerSessionIds),
        workspaceResultReconcilingSessionIds: byRequestedSet(
          projection.workspaceResultReconcilingSessionIds,
        ),
        workspaceRecoveryPendingSessionIds: byRequestedSet(
          projection.workspaceRecoveryPendingSessionIds,
        ),
      };
    },

    async readEnvironmentOwner(environmentId: string) {
      const result = await executeExistingOpenClawStateRead(
        { path },
        {
          type: "workers.placementEnvironmentOwner",
          environmentId: required(environmentId, "environment id"),
        },
        { current: true },
      );
      if (!result || !result.ok || result.type !== "workers.placementEnvironmentOwner") {
        throw new Error("Worker placement environment owner source is unavailable");
      }
      return result.placement;
    },

    async readRecoveryCandidates() {
      const result = await executeExistingOpenClawStateRead(
        { path },
        { type: "workers.placementRecoveryCandidates" },
        { current: true },
      );
      if (!result || !result.ok || result.type !== "workers.placementRecoveryCandidates") {
        throw new Error("Worker placement recovery candidates source is unavailable");
      }
      return result.candidates;
    },

    /** @deprecated Await getManyAsync; retained through the next Plugin SDK major. */
    getMany(sessionIds: readonly string[]): ReadonlyMap<string, WorkerSessionPlacementRecord> {
      const normalizedIds = [
        ...new Set(sessionIds.map((sessionId) => required(sessionId, "session id"))),
      ];
      const records = new Map<string, WorkerSessionPlacementRecord>();
      const db = read();
      for (let offset = 0; offset < normalizedIds.length; offset += 250) {
        const chunk = normalizedIds.slice(offset, offset + 250);
        for (const row of executeSqliteQuerySync(
          db,
          query(db)
            .selectFrom("worker_session_placements")
            .selectAll()
            .where("session_id", "in", chunk),
        ).rows) {
          const record = fromRow(row);
          records.set(record.sessionId, withWorkspaceResultConflict(record)!);
        }
      }
      return records;
    },

    /** @deprecated Await retireSessionPlacementAsync; retained through the next Plugin SDK major. */
    retireSessionPlacement(input: WorkerSessionPlacementRetirement): void {
      write((db) => retireWorkerSessionPlacement(db, input));
      workspaceResultConflicts.delete(required(input.sessionId, "session id"));
    },

    recordWorkspaceResultConflict(
      claim: WorkerSessionTurnClaim,
      conflict: WorkerWorkspaceResultConflict | undefined,
    ): void {
      const current = store.preparedWorkspaceResultPlacement(claim);
      if (!current) {
        throw new Error(`Session ${claim.sessionId} workspace result conflict owner changed`);
      }
      if (!conflict) {
        workspaceResultConflicts.delete(claim.sessionId);
        sessionChanges.emit({ agentId: current.agentId, sessionKey: current.sessionKey });
        return;
      }
      const paths = conflict.paths.map(exactConflictPath);
      const stagedResultRef = required(conflict.stagedResultRef, "staged result ref");
      if (
        paths.length === 0 ||
        !/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(stagedResultRef)
      ) {
        throw new Error("Cloud workspace result conflict projection is invalid");
      }
      workspaceResultConflicts.set(claim.sessionId, {
        conflict: projectWorkspaceResultConflict(paths, stagedResultRef, conflict.totalCount),
        placement: current,
        claim: { ...claim },
      });
      sessionChanges.emit({ agentId: current.agentId, sessionKey: current.sessionKey });
    },

    startDispatch(
      input: WorkerSessionPlacementDispatchIdentity,
      dispatchOptions: { assertCurrent?: () => void } = {},
    ): Promise<WorkerSessionPlacementRecord> {
      return startWorkerPlacementDispatch(path, input, now(), dispatchOptions.assertCurrent);
    },

    async adoptActive(input: {
      sessionId: string;
      environmentId: string;
      ownerEpoch: number;
      expectedGeneration?: number;
    }): Promise<WorkerSessionPlacementRecord> {
      const sessionId = required(input.sessionId, "session id");
      const environmentId = required(input.environmentId, "environment id");
      const ownerEpoch = normalizeEpoch(input.ownerEpoch, "active owner epoch");
      const current = await store.getAsync(sessionId);
      if (
        current?.state !== "active" ||
        current.environmentId !== environmentId ||
        current.activeOwnerEpoch !== ownerEpoch ||
        (input.expectedGeneration !== undefined && current.generation !== input.expectedGeneration)
      ) {
        throw new Error(`Cannot adopt stale worker placement for session ${sessionId}`);
      }
      return current;
    },

    listForReconcile(sessionKey?: string): WorkerSessionPlacementRecord[] {
      return readWorkerPlacementsForReconcileInDatabase(read(), sessionKey).map((record) =>
        withWorkspaceResultConflict(record)!,
      );
    },

    list(): WorkerSessionPlacementRecord[] {
      const db = read();
      return executeSqliteQuerySync(
        db,
        query(db).selectFrom("worker_session_placements").selectAll().orderBy("session_id"),
      ).rows.map((row) => withWorkspaceResultConflict(fromRow(row))!);
    },

    async readChangeSnapshot(profileIds?: readonly string[]) {
      const reply = await executeExistingOpenClawStateRead(
        { path },
        {
          type: "workerPlacements.changeSnapshot",
          profileIds: profileIds ? [...profileIds] : undefined,
        },
        { current: true },
      );
      if (!reply || !reply.ok || reply.type !== "workerPlacements.changeSnapshot") {
        throw new Error("Worker placement change snapshot is unavailable");
      }
      return reply.placements;
    },
  };
  attachWorkerTurnExecutionIdentityStore(store, path);
  return store;
}

export type WorkerSessionPlacementStore = ReturnType<typeof createWorkerSessionPlacementStore>;
export type WorkerSessionPlacementRetirementService = Pick<
  WorkerSessionPlacementStore,
  "retireSessionPlacement" | "retireSessionPlacementAsync"
>;
