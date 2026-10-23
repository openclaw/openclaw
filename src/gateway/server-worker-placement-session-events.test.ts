import { expect, it, vi } from "vitest";
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
import {
  createIdleDiskSpace,
  createRuntimeFactory,
  placementAsyncDefaults,
  setDispatchMock,
  startRuntime as startSidecar,
} from "./server-worker-placement.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { sessionIdentity } from "./worker-environments/placement-suite.test-support.js";

type RuntimeOptions = Parameters<typeof createGatewayWorkerPlacementRuntime>[0];
const createRuntime = createRuntimeFactory(createGatewayWorkerPlacementRuntime, getRuntimeConfig);

async function releaseLocalTurn(
  placements: RuntimeOptions["placements"],
  identity: ReturnType<typeof sessionIdentity>,
) {
  await placements.releaseTurn(
    await placements.claimTurn({
      ...identity,
      claimId: `${identity.sessionId}-claim`,
      runId: `${identity.sessionId}-run`,
      owner: { kind: "local" },
    }),
  );
}

function emitDeletion(databaseIdentity: symbol) {
  emitSessionIdentityMutation({
    kind: "delete",
    agentId: "main",
    databaseIdentity,
    previous: { sessionId: "retired-session", sessionKeys: ["agent:main:retired"] },
  });
}

function startRuntime(
  time: ReturnType<typeof createGatewaySchedulerClock>,
  reconcileActive: () => Promise<void>,
  warn: RuntimeOptions["warn"],
  placements: RuntimeOptions["placements"] = placementAsyncDefaults() as never,
) {
  runtimeFactoryMocks.createDiskSpace.mockReturnValue({
    ...createIdleDiskSpace(),
    version: () => 0,
  });
  setDispatchMock(runtimeFactoryMocks.createDispatch, { reconcileActive });
  return startSidecar(
    createRuntime({
      scheduler: createTestGatewayScheduler(time.clock),
      placements,
      warn,
    }),
  );
}

it("retires changed placements after real placement and session writes without idle rescans", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const time = createGatewaySchedulerClock();
    const placements = createWorkerSessionPlacementStore({
      database: openOpenClawStateDatabase(),
    });
    const identity = sessionIdentity("retirement-current");
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
    await upsertSessionEntryCore(
      { ...identity, storePath },
      { sessionId: identity.sessionId, updatedAt: Date.now() },
    );
    await releaseLocalTurn(placements, identity);
    const evidence = await vi.importActual<
      typeof import("./server-worker-placement-session-evidence.js")
    >("./server-worker-placement-session-evidence.js");
    runtimeFactoryMocks.createSessionEvidenceResolver.mockImplementation(
      evidence.createWorkerPlacementSessionEvidenceResolver,
    );
    const list = vi.spyOn(placements, "listAsync");
    let reconciled = createDeferredCore();
    const warn = vi.fn();
    const sidecar = await startRuntime(
      time,
      vi.fn(async () => reconciled.resolve()),
      warn,
      placements,
    );
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

      const orphan = sessionIdentity("retirement-orphan");
      await releaseLocalTurn(placements, orphan);
      await time.advanceBy(60_000);
      expect(await placements.getAsync(orphan.sessionId)).toBeUndefined();
      expect(await placements.getAsync(identity.sessionId)).toMatchObject(identity);
      expect(runtimeFactoryMocks.createSessionEvidenceResolver).toHaveBeenLastCalledWith(
        [expect.objectContaining(orphan)],
        expect.any(AbortSignal),
      );
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
      expect(runtimeFactoryMocks.createSessionEvidenceResolver).toHaveBeenLastCalledWith(
        [expect.objectContaining(identity)],
        expect.any(AbortSignal),
      );
      expect(list).toHaveBeenCalledTimes(3);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await sidecar?.stop();
    }
  }));

it("finishes background reconciliation after the notifying session request closes", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const time = createGatewaySchedulerClock();
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
    const warn = vi.fn();
    const sidecar = await startRuntime(time, reconcileActive, warn);
    try {
      await time.advanceBy(60_000);
      reconcileActive.mockClear();
      completed = createDeferredCore<boolean>();
      const request = new AsyncWorkScope();
      request.run(() => emitDeletion(Symbol("session-database")));
      await request.drain();
      expect(await completed.promise).toBe(true);
      expect(reconcileActive).toHaveBeenCalledOnce();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await sidecar?.stop();
    }
  }));

it("reports a failed reconciliation queued by a session change without leaking rejection", async () => {
  const time = createGatewaySchedulerClock();
  const releaseReconcile = createDeferredCore();
  const reconcileStarted = createDeferredCore();
  const failureReported = createDeferredCore();
  const reconcileActive = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const warn = vi.fn(() => failureReported.resolve());
  const sidecar = await startRuntime(time, reconcileActive, warn);
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
    emitDeletion(Symbol("worker-placement-database"));
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
