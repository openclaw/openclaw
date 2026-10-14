import { describe, expect, it, vi } from "vitest";
import { getWorkerPlacementStartupMocks } from "./server-worker-placement-startup.test-harness.js";

const { runtimeFactoryMocks } = getWorkerPlacementStartupMocks();

import { getRuntimeConfig } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.sqlite-lifecycle.js";
import { emitSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

describe("worker placement session events", () => {
  it("retires changed placements after real placement and session writes without idle rescans", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const time = createGatewaySchedulerClock();
      const placements = createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase(),
      });
      const identity = {
        sessionId: "session-retirement-current",
        sessionKey: "agent:main:retirement-current",
        agentId: "main",
      };
      const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
      await upsertSessionEntryCore(
        { ...identity, storePath },
        { sessionId: identity.sessionId, updatedAt: Date.now() },
      );
      const claim = await placements.claimTurn({
        ...identity,
        claimId: "retirement-current-claim",
        runId: "retirement-current-run",
        owner: { kind: "local" },
      });
      await placements.releaseTurn(claim);
      const evidence = await vi.importActual<
        typeof import("./server-worker-placement-session-evidence.js")
      >("./server-worker-placement-session-evidence.js");
      runtimeFactoryMocks.createSessionEvidenceResolver.mockImplementation(
        evidence.createWorkerPlacementSessionEvidenceResolver,
      );
      const list = vi.spyOn(placements, "listAsync");
      let reconciled = createDeferredCore();
      runtimeFactoryMocks.createDiskSpace.mockReturnValue({
        read: vi.fn(),
        version: () => 0,
        invalidate: vi.fn(),
        nextSweepAtMs: () => Infinity,
        sweep: vi.fn().mockResolvedValue(undefined),
      });
      runtimeFactoryMocks.createDispatch.mockReturnValue({
        dispatch: vi.fn(),
        forceDestroyEnvironment: vi.fn(),
        reclaim: vi.fn(),
        reconcile: vi.fn().mockResolvedValue(undefined),
        reconcileActive: vi.fn(async () => reconciled.resolve()),
      });
      const warn = vi.fn();
      const runtime = createGatewayWorkerPlacementRuntime({
        initialPlacements: [],
        scheduler: createTestGatewayScheduler(time.clock),
        getCommittedRuntimeConfig: getRuntimeConfig,
        cancelSessionWork: vi.fn(async () => {}),
        placements,
        environments: {
          subscribeMachineShapeChanged: () => () => {},
          installReconcileEnvironmentGuard: () => () => {},
          start() {},
          stop: async () => {},
        } as never,
        gatewayNamespace: "gateway-test",
        revokeSessionAuthority: vi.fn(),
        warn,
      });
      const sidecar = await runtime.startRuntime({
        isClosePreludeStarted: () => false,
        registerSidecar: vi.fn(),
        unregisterSidecar: vi.fn(),
      });
      try {
        await time.advanceBy(60_000);
        await time.advanceBy(60_000);
        expect(list).toHaveBeenCalledOnce();
        expect(runtimeFactoryMocks.createSessionEvidenceResolver).toHaveBeenCalledOnce();
        expect(await placements.getAsync(identity.sessionId)).toMatchObject(identity);

        sessionChanges.emit({ all: true, scope: "worker-placements" });
        sessionChanges.emit({ all: true, scope: "config-presentation" });
        sessionChanges.emit({
          sessionKey: identity.sessionKey,
          scope: "transcript",
          factsInvalidated: true,
        });
        await time.advanceBy(60_000);
        expect(list).toHaveBeenCalledOnce();
        expect(runtimeFactoryMocks.createSessionEvidenceResolver).toHaveBeenCalledOnce();

        const invalidations: SessionRowChange[] = [
          { all: true, scope: "config" },
          { ...identity, factsInvalidated: true },
        ];
        for (const [index, change] of invalidations.entries()) {
          sessionChanges.emit(change);
          await time.advanceBy(60_000);
          expect(list).toHaveBeenCalledTimes(2 + index);
        }

        const orphan = {
          sessionId: "session-retirement-orphan",
          sessionKey: "agent:main:retirement-orphan",
          agentId: "main",
        };
        const orphanClaim = await placements.claimTurn({
          ...orphan,
          claimId: "retirement-orphan-claim",
          runId: "retirement-orphan-run",
          owner: { kind: "local" },
        });
        await placements.releaseTurn(orphanClaim);
        await time.advanceBy(60_000);
        expect(await placements.getAsync(orphan.sessionId)).toBeUndefined();
        expect(await placements.getAsync(identity.sessionId)).toMatchObject(identity);
        expect(runtimeFactoryMocks.createSessionEvidenceResolver).toHaveBeenLastCalledWith([
          expect.objectContaining(orphan),
        ]);
        expect(list).toHaveBeenCalledTimes(3);

        reconciled = createDeferredCore();
        await deleteSessionEntryLifecycle({
          agentId: identity.agentId,
          storePath,
          archiveTranscript: false,
          target: { canonicalKey: identity.sessionKey, storeKeys: [identity.sessionKey] },
        });
        await reconciled.promise;
        expect(await placements.getAsync(identity.sessionId)).toBeUndefined();
        expect(runtimeFactoryMocks.createSessionEvidenceResolver).toHaveBeenLastCalledWith([
          expect.objectContaining(identity),
        ]);
        expect(list).toHaveBeenCalledTimes(3);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        await sidecar?.stop();
      }
    });
  });

  it("finishes background reconciliation after the notifying session request closes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const time = createGatewaySchedulerClock();
      const scheduler = createTestGatewayScheduler(time.clock);
      const placements = createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase(),
      });
      let completed = createDeferredCore<boolean>();
      const reconcileActive = vi.fn(async () => {
        try {
          await placements.readRecoveryCandidates();
          completed.resolve(true);
        } catch (error) {
          completed.resolve(false);
          throw error;
        }
      });
      runtimeFactoryMocks.createDiskSpace.mockReturnValue({
        read: vi.fn(),
        version: () => 0,
        invalidate: vi.fn(),
        nextSweepAtMs: () => Infinity,
        sweep: vi.fn().mockResolvedValue(undefined),
      });
      runtimeFactoryMocks.createDispatch.mockReturnValue({
        dispatch: vi.fn(),
        forceDestroyEnvironment: vi.fn(),
        reclaim: vi.fn(),
        reconcile: vi.fn().mockResolvedValue(undefined),
        reconcileActive,
      });
      const warn = vi.fn();
      const runtime = createGatewayWorkerPlacementRuntime({
        initialPlacements: [],
        scheduler,
        getCommittedRuntimeConfig: getRuntimeConfig,
        cancelSessionWork: vi.fn(async () => {}),
        placements: {
          subscribeChanges: () => () => {},
          workspaceResultInstanceId: () => "gateway-test",
          getAsync: async () => undefined,
          getManyAsync: async () => new Map(),
          listAsync: async () => [],
          retireSessionPlacementAsync: vi.fn(async () => {}),
          pruneOrphanedWorkspaceReconciliations: async () => [],
          listWorkspaceReconciliationOwners: async () => [],
          listPendingWorkspaceResultsAsync: async () => [],
        } as never,
        environments: {
          subscribeMachineShapeChanged: vi.fn(() => vi.fn()),
          installReconcileEnvironmentGuard: vi.fn(() => vi.fn()),
          start: vi.fn(),
          stop: vi.fn().mockResolvedValue(undefined),
        } as never,
        gatewayNamespace: "gateway-test",
        revokeSessionAuthority: vi.fn(),
        warn,
      });
      const sidecar = await runtime.startRuntime({
        isClosePreludeStarted: () => false,
        registerSidecar: vi.fn(),
        unregisterSidecar: vi.fn(),
      });
      try {
        await time.advanceBy(60_000);
        reconcileActive.mockClear();
        completed = createDeferredCore<boolean>();
        const request = new AsyncWorkScope();
        request.run(() =>
          emitSessionIdentityMutation({
            kind: "delete",
            agentId: "main",
            databaseIdentity: Symbol("session-database"),
            previous: { sessionId: "retired-session", sessionKeys: ["agent:main:retired"] },
          }),
        );
        await request.drain();
        expect(await completed.promise).toBe(true);
        expect(reconcileActive).toHaveBeenCalledOnce();
        expect(warn).not.toHaveBeenCalled();
      } finally {
        await sidecar?.stop();
      }
    });
  });

  it("reports a failed reconciliation queued by a session change without leaking rejection", async () => {
    const time = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(time.clock);
    const databaseIdentity = Symbol("worker-placement-database");
    const releaseReconcile = createDeferredCore();
    const reconcileStarted = createDeferredCore();
    const failureReported = createDeferredCore();
    const reconcileActive = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    runtimeFactoryMocks.createDiskSpace.mockReturnValue({
      read: vi.fn(),
      version: () => 0,
      invalidate: vi.fn(),
      nextSweepAtMs: () => Infinity,
      sweep: vi.fn().mockResolvedValue(undefined),
    });
    runtimeFactoryMocks.createDispatch.mockReturnValue({
      dispatch: vi.fn(),
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile: vi.fn().mockResolvedValue(undefined),
      reconcileActive,
    });
    const warn = vi.fn(() => failureReported.resolve());
    const runtime = createGatewayWorkerPlacementRuntime({
      initialPlacements: [],
      scheduler,
      getCommittedRuntimeConfig: getRuntimeConfig,
      cancelSessionWork: vi.fn(async () => {}),
      placements: {
        subscribeChanges: () => () => {},
        workspaceResultInstanceId: () => "gateway-test",
        getAsync: async () => undefined,
        getManyAsync: async () => new Map(),
        listAsync: async () => [],
        retireSessionPlacementAsync: vi.fn(async () => {}),
        pruneOrphanedWorkspaceReconciliations: async () => [],
        listWorkspaceReconciliationOwners: async () => [],
        listPendingWorkspaceResultsAsync: async () => [],
      } as never,
      environments: {
        subscribeMachineShapeChanged: vi.fn(() => vi.fn()),
        installReconcileEnvironmentGuard: vi.fn(() => vi.fn()),
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      } as never,
      gatewayNamespace: "gateway-test",
      revokeSessionAuthority: vi.fn(),
      warn,
    });
    const sidecar = await runtime.startRuntime({
      isClosePreludeStarted: () => false,
      registerSidecar: vi.fn(),
      unregisterSidecar: vi.fn(),
    });
    let scheduledWake: void | Promise<void> = undefined;
    try {
      await time.advanceBy(60_000);
      expect(warn).not.toHaveBeenCalled();
      reconcileActive.mockClear();
      reconcileActive
        .mockImplementationOnce(() => {
          reconcileStarted.resolve();
          return releaseReconcile.promise;
        })
        .mockRejectedValue(new Error("Worker environment inventory has closed"));
      scheduledWake = time.advanceBy(60_000);
      await reconcileStarted.promise;
      expect(reconcileActive).toHaveBeenCalledOnce();
      emitSessionIdentityMutation({
        kind: "delete",
        agentId: "main",
        databaseIdentity,
        previous: { sessionId: "retired-session", sessionKeys: ["agent:main:retired"] },
      });
      releaseReconcile.resolve();
      await failureReported.promise;
      expect(reconcileActive).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        "Worker placement reconcile sweep failed: Worker environment inventory has closed",
      );
    } finally {
      releaseReconcile.resolve();
      await sidecar?.stop();
      await scheduledWake;
    }
  });
});
