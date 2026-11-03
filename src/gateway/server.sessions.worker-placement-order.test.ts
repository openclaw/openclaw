import { expect, test } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createGatewayWorkerPlacementMoveBarrier } from "./server-worker-placement-move-barrier.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "./session-utils-store.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { coordinateWorkerPlacementDispatch } from "./worker-environments/placement-dispatch-coordinator.js";
import { createCoordinatorTestService } from "./worker-environments/placement-dispatch-coordinator.test-support.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-store.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

const unexpectedPlacementOperation = async (): Promise<never> => {
  throw new Error("Unexpected placement operation in lifecycle ordering test");
};

test.for(["delete", "archive"] as const)(
  "%s lets an earlier move acquire its session fence before reclaim",
  async (action, { signal }) => {
    const { storePath } = await createSessionStoreDir();
    const sessionId = `lifecycle-order-${action}`;
    const sessionKey = `agent:main:${sessionId}`;
    const identity = { sessionId, sessionKey, agentId: "main" };
    const worktree = { id: "order-worktree", ownerId: sessionKey, path: "/fixture/worktree" };
    const seed = sessionStoreEntry(sessionId, {
      worktree: { id: worktree.id, branch: "order-branch", repoRoot: "/fixture/repo" },
      lifecycleRevision: "original-lifecycle",
    });
    await writeSessionStore({ entries: { [sessionKey]: seed } });
    let placement = {
      ...identity,
      state: "active",
      generation: 4,
      environmentId: "order-environment",
      activeOwnerEpoch: 2,
      turnClaim: null,
    } as WorkerSessionPlacementRecord;
    const moveLoading = createDeferredCore();
    const releaseMove = createDeferredCore();
    const reclaimEntered = createDeferredCore();
    const cleanupBlockedReclaim = createDeferredCore<never>();
    let moveAcquired = false;
    let serializedReclaim: Promise<unknown> | undefined;
    const moveBarrier = createGatewayWorkerPlacementMoveBarrier({
      placements: { waitForTurnClaimRelease: async () => {} },
      loadSessionRuntime: async () => {
        moveLoading.resolve();
        await releaseMove.promise;
        return {
          managedWorktrees: { findLiveByOwner: async () => worktree },
          resolveGatewaySessionStoreTargetInWorker: (params) =>
            resolveGatewaySessionStoreTargetInWorker({
              ...params,
              cfg: { ...params.cfg, session: { ...params.cfg.session, store: storePath } },
            }),
          resolveCanonicalSessionEntryFromStoreKeys,
        };
      },
      revokeSessionAuthority: () => {},
    });
    const service = coordinateWorkerPlacementDispatch(
      createCoordinatorTestService({
        readEnvironmentSessionIds: unexpectedPlacementOperation,
        move: async () => {
          await moveBarrier({
            ...identity,
            sourceDisposition: "reconcile",
            begin: async () => {
              moveAcquired = true;
              throw new Error("move preflight rejected");
            },
          });
          throw new Error("test Move preflight unexpectedly completed");
        },
        reclaim: async (_request, authorize, beforeDrain, serialize) => {
          reclaimEntered.resolve();
          const reclaim = serialize!(async () => {
            authorize?.();
            beforeDrain?.();
            placement = {
              ...placement,
              state: "reclaimed",
              generation: 7,
            } as WorkerSessionPlacementRecord;
            return placement as Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;
          });
          serializedReclaim = reclaim;
          return await Promise.race([reclaim, cleanupBlockedReclaim.promise]);
        },
      }),
      (_request, run) => run(),
    );
    const moving = service
      .move({
        ...identity,
        source: { generation: 4, environmentId: "order-environment", ownerEpoch: 2 },
        target: { kind: "gateway" },
      })
      .catch((error: unknown) => error);
    await moveLoading.promise;
    const lifecycle = directSessionReq(
      action === "archive" ? "sessions.patch" : `sessions.${action}`,
      action === "archive"
        ? {
            key: sessionKey,
            archived: true,
            expectedSessionId: sessionId,
            expectedLifecycleRevision: "original-lifecycle",
          }
        : { key: sessionKey },
      {
        context: {
          workerPlacementDispatchService: service,
          workerSessionPlacementService: {
            getMany: () => new Map([[sessionId, placement]]),
            retireSessionPlacement: () => {},
          },
        },
      },
    );
    try {
      await awaitGateBeforeSettlement(
        reclaimEntered.promise,
        lifecycle,
        "Lifecycle returned before reclaim",
      );
      releaseMove.resolve();
      // The retained worker read can finish after the next event-loop turn.
      await withinTest(moving, signal);
      expect(await moving).toMatchObject({ message: "move preflight rejected" });
      expect(moveAcquired).toBe(true);
      await serializedReclaim;
    } finally {
      // Unwind the real queues even when the ordering assertions fail.
      releaseMove.resolve();
      cleanupBlockedReclaim.reject(new Error("test released blocked reclaim"));
      await Promise.allSettled([moving, lifecycle, cleanupBlockedReclaim.promise]);
      await serializedReclaim?.catch(() => {});
    }
    const result = await lifecycle;
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    const entry = (await loadSessionEntryAsync(sessionKey)).entry;
    if (action === "delete") {
      expect(entry).toBeUndefined();
    } else {
      expect(entry?.archivedAt).toEqual(expect.any(Number));
    }
  },
);
