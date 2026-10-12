import { randomUUID } from "node:crypto";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { createPlacementLifecycleWorkerOps } from "./placement-lifecycle-store.js";
import type { WorkerSessionPlacementProjection } from "./placement-read-projection.types.js";
import { readPublishedPlacementProjection } from "./placement-read-publication.js";
import { createPlacementReadStore } from "./placement-read-store.js";
import {
  normalizeEpoch,
  projectWorkerSessionTurnClaim,
  required,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import type { WorkerSessionPlacementRetirement } from "./placement-retirement.js";
import { createPlacementSessionToolOperationOps } from "./placement-session-tool-operations.js";
import {
  capturePlacementReplicaRead,
  isPublishedPlacementTurnClaimCurrent,
  readPlacementReplica,
  preparePlacementAuthorityRead,
  preparePlacementPreservationRead,
  preparePlacementTurnClaimAuthority,
  prepareSessionPlacementRead,
  readPlacementProjection,
  type PlacementTurnClaimAuthority,
} from "./placement-turn-authority.js";
import {
  attachWorkerTurnExecutionIdentityStore,
  registerWorkerTurnClaimClosedHandler,
} from "./placement-turn-claim-events.js";
import { createPlacementTurnClaimWorkerOps } from "./placement-turn-claims-store.js";
import { waitForPlacementTurnClaimRelease } from "./placement-turn-wait.js";
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
  const runtime = { path, instanceId: randomUUID(), now };
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
    ...createPlacementWorkspaceReservationOps(
      runtime,
      (sessionId): Promise<WorkerSessionPlacementProjection> =>
        store.readProjection([sessionId], { current: true }),
    ),
    /** @deprecated Await clearLocalTurnClaimsAfterRestartAsync; removed in the next Plugin SDK major. */
    clearLocalTurnClaimsAfterRestart(): number {
      warnPluginSdkDeprecation({
        family: "worker-placement-sync-writers",
        method: "clearLocalTurnClaimsAfterRestart",
        replacement: "clearLocalTurnClaimsAfterRestartAsync",
        compatibility:
          "Synchronous placement writes now fail with migration guidance; await the replacement.",
      });
      throw new Error(
        "Await clearLocalTurnClaimsAfterRestartAsync; synchronous placement writes are no longer supported.",
      );
    },
    waitForTurnClaimRelease: (
      sessionId: string,
      waitOptions: { timeoutMs?: number; signal?: AbortSignal },
    ) => waitForPlacementTurnClaimRelease(path, sessionId, waitOptions, store.getAsync),
    validateTurnClaim(claim: WorkerSessionTurnClaim): boolean {
      context.admission.assertCurrent();
      return isPublishedPlacementTurnClaimCurrent(context.admission.identity, claim);
    },
    readWorkerTurnClaim(binding: {
      sessionId: string;
      environmentId: string;
      ownerEpoch: number;
    }): WorkerSessionTurnClaim | undefined {
      context.admission.assertCurrent();
      const record = readPlacementReplica(context.admission.identity, binding.sessionId)?.placement;
      const claim = record ? projectWorkerSessionTurnClaim(record) : undefined;
      return claim?.owner.environmentId === binding.environmentId &&
        claim.owner.ownerEpoch === binding.ownerEpoch &&
        isPublishedPlacementTurnClaimCurrent(context.admission.identity, claim)
        ? claim
        : undefined;
    },
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

    /** @deprecated Await getAsync for cold reads; this method uses only prepared in-process facts. */
    get(sessionId: string): WorkerSessionPlacementRecord | undefined {
      warnPluginSdkDeprecation({
        family: "worker-placement-sync-readers",
        method: "get",
        replacement: "getAsync",
        compatibility:
          "Synchronous reads use committed in-process receipts; cold or inventory reads require the async replacement.",
      });
      context.admission.assertCurrent();
      const cached = readPlacementReplica(
        context.admission.identity,
        required(sessionId, "session id"),
      );
      if (!cached) {
        throw new Error(
          "Await getAsync to read a placement without a committed in-process receipt.",
        );
      }
      return withWorkspaceResultConflict(structuredClone(cached.placement));
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

    prepareSessionPlacement(sessionIdInput: string) {
      const sessionId = required(sessionIdInput, "session id");
      return prepareSessionPlacementRead(path, sessionId, () => store.getAsync(sessionId));
    },

    async prepareMaintenancePlacements() {
      return await preparePlacementPreservationRead(path, async () => {
        const result = await executeExistingOpenClawStateRead(
          { path },
          { type: "workers.placementPreservation" },
          { current: true },
        );
        if (!result || !result.ok || result.type !== "workers.placementPreservation") {
          throw new Error("Worker placement preservation source is unavailable");
        }
        return result.placements;
      });
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
      const loadProjection = async () => {
        const publish = capturePlacementReplicaRead(context.admission.identity);
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
        publish(result.result.projection.placements.values(), ids);
        return result.result;
      };
      const singleSessionId = ids.length === 1 ? ids[0] : undefined;
      const { projection, conflictSessionIds } =
        singleSessionId !== undefined && conflicts.size === 0
          ? await readPlacementProjection(path, singleSessionId, loadProjection)
          : await loadProjection();
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

    readPublishedProjection(change: SessionRowChange) {
      const projection = readPublishedPlacementProjection(context.admission.identity, change);
      if (!projection) {
        return undefined;
      }
      try {
        context.admission.assertCurrent();
        return projection;
      } catch {
        // A replaced reader must use ordinary preparation, never the old receipt.
        return undefined;
      }
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
      warnPluginSdkDeprecation({
        family: "worker-placement-sync-readers",
        method: "getMany",
        replacement: "getManyAsync",
        compatibility:
          "Synchronous reads use committed in-process receipts; cold or inventory reads require the async replacement.",
      });
      const records = new Map<string, WorkerSessionPlacementRecord>();
      for (const sessionId of sessionIds) {
        const record = store.get(sessionId);
        if (record) {
          records.set(record.sessionId, record);
        }
      }
      return records;
    },

    /** @deprecated Await retireSessionPlacementAsync; removed in the next Plugin SDK major. */
    retireSessionPlacement(input: WorkerSessionPlacementRetirement): void {
      warnPluginSdkDeprecation({
        family: "worker-placement-sync-writers",
        method: "retireSessionPlacement",
        replacement: "retireSessionPlacementAsync",
        compatibility:
          "Synchronous placement writes now fail with migration guidance; await the replacement.",
      });
      void input;
      throw new Error(
        "Await retireSessionPlacementAsync; synchronous placement writes are no longer supported.",
      );
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

    /** @deprecated Await listForReconcileAsync; retained through the next Plugin SDK major. */
    listForReconcile(sessionKey?: string): WorkerSessionPlacementRecord[] {
      warnPluginSdkDeprecation({
        family: "worker-placement-sync-readers",
        method: "listForReconcile",
        replacement: "listForReconcileAsync",
        compatibility:
          "Synchronous reads use committed in-process receipts; cold or inventory reads require the async replacement.",
      });
      void sessionKey;
      throw new Error(
        "Await listForReconcileAsync; synchronous placement inventory reads are no longer supported.",
      );
    },

    /** @deprecated Await listAsync; retained through the next Plugin SDK major. */
    list(): WorkerSessionPlacementRecord[] {
      warnPluginSdkDeprecation({
        family: "worker-placement-sync-readers",
        method: "list",
        replacement: "listAsync",
        compatibility:
          "Synchronous reads use committed in-process receipts; cold or inventory reads require the async replacement.",
      });
      throw new Error(
        "Await listAsync; synchronous placement inventory reads are no longer supported.",
      );
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
