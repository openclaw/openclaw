import { expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { clearAgentRunContext } from "../infra/agent-run-registry.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createGatewayWorkerDispatchAdmission } from "./server-worker-placement-dispatch-admission.js";
import { createGatewayWorkerPlacementMoveBarrier } from "./server-worker-placement-move-barrier.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";
import { useReclaimFixtures } from "./server-worker-placement-reclaim.test-support.js";
import {
  admitWorkerStopChat,
  createWorkerStopChatContext,
} from "./server-worker-placement.test-harness.js";
import { coordinateWorkerPlacementDispatch } from "./worker-environments/placement-dispatch-coordinator.js";
import { REQUEST } from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";
import { prepareSessionWorkerPlacementStop } from "./worker-environments/session-placement-lifecycle.js";

const fixtures = useReclaimFixtures();
function waitFor(gate: Promise<unknown>, operation: Promise<unknown>) {
  return Promise.race([
    gate,
    operation.then((result): never => {
      throw result;
    }),
  ]);
}

function source(placement: {
  generation: number;
  environmentId: string;
  activeOwnerEpoch: number;
}) {
  return {
    generation: placement.generation,
    environmentId: placement.environmentId,
    ownerEpoch: placement.activeOwnerEpoch,
  };
}

async function cancellationLoadFixture(
  options: NonNullable<Parameters<typeof createHarness>[2]> = {},
  beforeCancellation?: () => Promise<void>,
) {
  const root = fixtures.makeRoot("worker-stop-advance-");
  const { database, placements, storePath, entry, runtime } = await fixtures.createSession(root, {
    worktreePath: root,
    lifecycleRevision: "original",
  });
  const context = createWorkerStopChatContext();
  let delayCancellation = false;
  const loading = createDeferredCore();
  const loaded = createDeferredCore();
  const cancellationStarted = vi.fn();
  let started = createDeferredCore();
  const barriers = createGatewayWorkerPlacementReclaimBarriers({
    placements,
    loadSessionRuntime: async () => runtime,
    cancelSessionWork: async (request) => {
      if (beforeCancellation) {
        await beforeCancellation();
      }
      if (delayCancellation) {
        delayCancellation = false;
        loading.resolve();
        await loaded.promise;
      }
      const cancellation = await import("./server-worker-placement-cancel.js");
      await cancellation.cancelGatewayWorkerSessionWork(context, {
        ...request,
        onCancellationStarted: () => {
          cancellationStarted();
          request.onCancellationStarted?.();
          started.resolve();
        },
      });
    },
    revokeSessionAuthority: vi.fn(),
  });
  const harness = await createHarness(database, placements, {
    workspacePath: root,
    ...barriers,
    ...options,
  });
  const coordinated = coordinateWorkerPlacementDispatch(
    harness.service,
    createGatewayWorkerDispatchAdmission(async () => runtime),
  );
  return {
    database,
    runtime,
    storePath,
    placements,
    entry,
    context,
    loading,
    loaded,
    cancellationStarted,
    harness,
    coordinated,
    armCancellation: () => {
      delayCancellation = true;
      started = createDeferredCore();
    },
    waitForCancellationStart: async (stopping: Promise<unknown>) => {
      await Promise.race([
        started.promise,
        stopping.then((result) => {
          throw result instanceof Error
            ? result
            : new Error("Stop settled before cancellation started");
        }),
      ]);
    },
  };
}

it.each(["same-owner", "replacement", "incarnation", "authorization"] as const)(
  "a later Stop retains its newer initial owner after captured dispatch completes (%s)",
  async (change) => {
    const provisioning = createDeferredCore();
    const provisioned = createDeferredCore();
    const firstLoading = createDeferredCore();
    const firstLoaded = createDeferredCore();
    const secondLoading = createDeferredCore();
    const secondLoaded = createDeferredCore();
    let loads = 0;
    const f = await cancellationLoadFixture({}, async () => {
      if (++loads === 1) {
        firstLoading.resolve();
        await firstLoaded.promise;
      } else if (loads === 2) {
        secondLoading.resolve();
        await secondLoaded.promise;
      }
    });
    vi.mocked(f.harness.environments.createWithRequest).mockImplementationOnce(async () => {
      provisioning.resolve();
      await provisioned.promise;
      return f.harness.ready;
    });
    const dispatch = f.coordinated.dispatch(REQUEST).catch((error: unknown) => error);
    await waitFor(provisioning.promise, dispatch);
    const first = f.coordinated.reclaim(REQUEST).catch((error: unknown) => error);
    let second: Promise<unknown> | undefined;
    try {
      await waitFor(firstLoading.promise, first);
      const initial = f.placements.get(REQUEST.sessionId);
      expect(initial?.state).toBe("provisioning");
      provisioned.resolve();
      await dispatch;
      const active = f.placements.get(REQUEST.sessionId);
      if (active?.state !== "active" || !initial) {
        throw new Error("Completed dispatch fixture did not establish its newer active owner");
      }
      expect(active.generation).toBeGreaterThan(initial.generation);
      let authorized = true;
      // Awaiting dispatch above also retires its coordinator record. B captures only
      // the older Stop, while its own initial placement is the completed active owner.
      second = f.coordinated
        .reclaim(REQUEST, () => {
          if (!authorized) {
            throw new Error("later caller access revoked");
          }
        })
        .catch((error: unknown) => error);
      await waitFor(secondLoading.promise, second);
      if (change === "replacement") {
        await f.placements.startDrain({
          sessionId: active.sessionId,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
          expectedGeneration: active.generation,
        });
      } else if (change === "incarnation") {
        f.entry.lifecycleRevision = "replacement";
        await replaceSessionEntry({ ...REQUEST, storePath: f.storePath }, f.entry);
      } else if (change === "authorization") {
        authorized = false;
      }
      secondLoaded.resolve();
      if (change === "same-owner") {
        await f.waitForCancellationStart(second);
        expect(f.harness.environments.destroy).not.toHaveBeenCalled();
        firstLoaded.resolve();
        expect(await first).toMatchObject({ state: "reclaimed" });
        expect(await second).toEqual(f.placements.get(REQUEST.sessionId));
        expect(f.harness.environments.destroy).toHaveBeenCalledOnce();
      } else {
        expect(await second).toBeInstanceOf(Error);
        expect(f.cancellationStarted).not.toHaveBeenCalled();
        expect(f.harness.environments.destroy).not.toHaveBeenCalled();
      }
    } finally {
      provisioned.resolve();
      firstLoaded.resolve();
      secondLoaded.resolve();
      await Promise.all([dispatch, first, second]);
      f.context.chatRunState.clear();
    }
  },
);

it.each(["missing", "local", "reclaimed"] as const)(
  "concurrent ordinary %s Stops leave local chat running without dispatch or Move",
  async (state) => {
    const f = await cancellationLoadFixture();
    if (state === "local") {
      const requested = await f.placements.startDispatch(REQUEST);
      const failed = await f.placements.fail({
        sessionId: REQUEST.sessionId,
        expectedGeneration: requested.generation,
        recoveryError: "fixture local placement",
      });
      await f.placements.transition({
        sessionId: REQUEST.sessionId,
        from: "failed",
        to: "local",
        expectedGeneration: failed.generation,
      });
    } else if (state === "reclaimed") {
      await f.coordinated.dispatch(REQUEST);
      await f.coordinated.reclaim(REQUEST);
    }
    f.cancellationStarted.mockClear();
    const cancellations = vi.fn();
    f.context.cancelRunBoundApprovals = cancellations;
    const runId = `ordinary-${state}`;
    const admitted = await (await admitWorkerStopChat({ ...REQUEST, ...f, runId })).promise;
    if (!admitted.ok) {
      throw new Error("Ordinary local chat fixture was not admitted");
    }
    const controller = admitted.value.activeRunAbort.controller;
    controller.signal.addEventListener("abort", () => admitted.value.cleanupAdmittedRun());
    f.context.chatRunState.getOrCreate(runId).buffer = "keep ordinary local output";
    const entered = createDeferredCore();
    const release = createDeferredCore();
    vi.mocked(f.harness.environments.reconcileOnce).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const sweep = f.coordinated.reconcileActive();
    await entered.promise;
    const first = f.coordinated.reclaim(REQUEST).catch((error: unknown) => error);
    const prepared = createDeferredCore();
    const second = f.coordinated
      .reclaim(REQUEST, undefined, () => prepared.resolve())
      .catch((error: unknown) => error);
    try {
      await waitFor(prepared.promise, second);
      release.resolve();
      const results = await Promise.all([first, second]);
      expect(controller.signal.aborted).toBe(false);
      expect(f.cancellationStarted).not.toHaveBeenCalled();
      expect(cancellations).not.toHaveBeenCalled();
      expect(f.context.chatRunState.getOrCreate(runId).buffer).toBe("keep ordinary local output");
      for (const result of results) {
        if (state === "reclaimed") {
          expect(result).toMatchObject({ state: "reclaimed" });
        } else {
          expect(result).toBeInstanceOf(Error);
        }
      }
    } finally {
      release.resolve();
      await Promise.all([sweep, first, second]);
      admitted.value.cleanupAdmittedRun();
      clearAgentRunContext(runId, admitted.value.lifecycleGeneration);
      f.context.chatRunState.clear();
    }
  },
);

it.each([false, true])(
  "Stop follows Move's acknowledged draining owner before barrier return (abandon=%s)",
  async (abandonSource) => {
    const entering = createDeferredCore();
    const begin = createDeferredCore();
    const begun = createDeferredCore();
    const finish = createDeferredCore();
    const f = await cancellationLoadFixture({
      runMoveBarrier: async (request) => {
        const result = await barrier(request);
        begun.resolve();
        await finish.promise;
        return result;
      },
    });
    const barrier = createGatewayWorkerPlacementMoveBarrier({
      placements: f.placements,
      loadSessionRuntime: async () => {
        entering.resolve();
        await begin.promise;
        return f.runtime;
      },
      revokeSessionAuthority: vi.fn(),
    });
    const active = await f.coordinated.dispatch(REQUEST);
    if (abandonSource) {
      f.harness.markEnvironmentNodeDeviceId("device-1");
      f.database.db
        .prepare("UPDATE worker_environments SET profile_id = ? WHERE environment_id = ?")
        .run("device:device-1", active.environmentId);
    }

    const transitions: string[] = [];
    const moving = f.coordinated
      .move(
        {
          ...REQUEST,
          source: source(active),
          target: { kind: "gateway" },
          ...(abandonSource ? { abandonSource: true as const } : {}),
        },
        (placement) => transitions.push(placement.state),
      )
      .catch((error: unknown) => error);
    await waitFor(entering.promise, moving);
    f.armCancellation();
    const stopping = f.coordinated.reclaim(REQUEST).catch((error: unknown) => error);
    try {
      await waitFor(f.loading.promise, stopping);
      expect(f.placements.get(REQUEST.sessionId)?.state).toBe("active");
      begin.resolve();
      await waitFor(begun.promise, moving);
      expect(f.placements.get(REQUEST.sessionId)?.state).toBe("draining");
      expect(transitions).toEqual(["draining"]);
      f.loaded.resolve();
      await f.waitForCancellationStart(stopping);
      expect(f.harness.environments.destroy).not.toHaveBeenCalled();
      finish.resolve();
      expect(await moving).toBeInstanceOf(Error);
      expect(await stopping).toMatchObject({ state: abandonSource ? "local" : "reclaimed" });
      expect(transitions.filter((state) => state === "draining")).toHaveLength(1);
      expect(f.harness.environments.destroy).toHaveBeenCalledOnce();
    } finally {
      begin.resolve();
      finish.resolve();
      f.loaded.resolve();
      await Promise.all([moving, stopping]);
      f.context.chatRunState.clear();
    }
  },
);

it.each(
  (["provisioning", "active"] as const).flatMap((phase) =>
    (["same-owner", "cleanup", "replacement", "incarnation"] as const).map((change) => ({
      phase,
      change,
    })),
  ),
)(
  "concurrent Stops retain their shared $phase cleanup owner ($change)",
  async ({ phase, change }) => {
    const entered = createDeferredCore();
    const released = createDeferredCore();
    const f = await cancellationLoadFixture(
      phase === "active"
        ? {
            afterReconcile: async () => {
              entered.resolve();
              await released.promise;
            },
          }
        : {},
    );
    if (phase === "provisioning") {
      vi.mocked(f.harness.environments.createWithRequest).mockImplementationOnce(async () => {
        entered.resolve();
        await released.promise;
        return f.harness.ready;
      });
    }
    const dispatch = f.coordinated.dispatch(REQUEST).catch((error: unknown) => error);
    if (phase === "active") {
      expect(await dispatch).toMatchObject({ state: "active" });
    } else {
      await entered.promise;
    }
    const first = f.coordinated.reclaim(REQUEST).catch((error: unknown) => error);
    await f.waitForCancellationStart(first);
    if (phase === "active") {
      await waitFor(entered.promise, first);
    }
    f.armCancellation();
    let secondSettled = false;
    const second = f.coordinated
      .reclaim(REQUEST)
      .catch((error: unknown) => error)
      .finally(() => {
        secondSettled = true;
      });
    try {
      await waitFor(f.loading.promise, second);
      if (change === "cleanup") {
        f.loaded.resolve();
        await f.waitForCancellationStart(second);
        expect(secondSettled).toBe(false);
        expect(f.harness.environments.destroy).not.toHaveBeenCalled();
      }
      released.resolve();
      const completed = await first;
      expect(completed).toMatchObject({ state: phase === "active" ? "reclaimed" : "local" });
      expect(f.harness.environments.destroy).toHaveBeenCalledOnce();
      const cancellations = f.cancellationStarted.mock.calls.length;
      if (change === "replacement") {
        await f.placements.startDispatch(REQUEST);
      } else if (change === "incarnation") {
        f.entry.lifecycleRevision = "replacement";
        await replaceSessionEntry({ ...REQUEST, storePath: f.storePath }, f.entry);
      }
      f.loaded.resolve();
      const result = await second;
      if (change === "same-owner" || change === "cleanup") {
        expect(result).toEqual(completed);
        expect(f.placements.get(REQUEST.sessionId)).toEqual(completed);
      } else {
        expect(result).toBeInstanceOf(Error);
        expect(f.cancellationStarted).toHaveBeenCalledTimes(cancellations);
      }
      expect(f.harness.environments.destroy).toHaveBeenCalledOnce();
    } finally {
      released.resolve();
      f.loaded.resolve();
      await Promise.all([dispatch, first, second]);
      f.context.chatRunState.clear();
    }
  },
);

it.each([
  ...(["syncing", "completed", "failed", "replacement", "incarnation", "observer"] as const).map(
    (advance) => ({ advance, action: "stop" as const }),
  ),
  ...(["syncing", "failed", "replacement"] as const).map((advance) => ({
    advance,
    action: "archive" as const,
  })),
])(
  "$action retains captured dispatch authority across cancellation loading ($advance)",
  async ({ advance, action }) => {
    const f = await cancellationLoadFixture(advance === "failed" ? { failAt: "sync" } : {});
    const provisioning = createDeferredCore();
    const provisioned = createDeferredCore();
    const attaching = createDeferredCore();
    const attached = createDeferredCore();
    let dispatchSignal: AbortSignal | undefined;
    vi.mocked(f.harness.environments.createWithRequest).mockImplementationOnce(
      async ({ signal }) => {
        dispatchSignal = signal;
        provisioning.resolve();
        await provisioned.promise;
        return f.harness.ready;
      },
    );
    if (advance === "syncing") {
      const attach = f.harness.environments.attachSession;
      f.harness.environments.attachSession = vi.fn(async (request) => {
        attaching.resolve();
        await attached.promise;
        return await attach(request);
      });
    }
    const dispatch = f.coordinated
      .dispatch(REQUEST, (placement) => {
        if (advance === "observer" && placement.state === "active") {
          placement.generation += 100;
        }
      })
      .catch((error: unknown) => error);
    await provisioning.promise;
    f.armCancellation();
    const stopping = Promise.resolve()
      .then(async () => {
        if (action === "archive") {
          return await (
            await prepareSessionWorkerPlacementStop({
              ...REQUEST,
              action,
              context: {
                workerSessionPlacementService: f.placements,
                workerPlacementDispatchService: f.coordinated,
                workerEnvironmentService: f.harness.environments,
              },
            })
          ).stop();
        }
        return await f.coordinated.reclaim(REQUEST);
      })
      .catch((error: unknown) => error);
    try {
      await waitFor(f.loading.promise, stopping);
      expect(f.placements.get(REQUEST.sessionId)?.state).toBe("provisioning");
      expect(dispatchSignal?.aborted).toBe(false);
      provisioned.resolve();
      if (advance === "syncing") {
        await attaching.promise;
        expect(f.placements.get(REQUEST.sessionId)?.state).toBe("syncing");
      } else {
        await dispatch;
        expect(f.placements.get(REQUEST.sessionId)?.state).toBe(
          advance === "failed" ? "failed" : "active",
        );
      }
      if (advance === "replacement") {
        const current = f.placements.get(REQUEST.sessionId);
        if (current?.state !== "active") {
          throw new Error("Replacement fixture requires a completed active dispatch");
        }
        await f.placements.startDrain({
          sessionId: current.sessionId,
          environmentId: current.environmentId,
          ownerEpoch: current.activeOwnerEpoch,
          expectedGeneration: current.generation,
        });
      } else if (advance === "incarnation") {
        f.entry.lifecycleRevision = "replacement";
        await replaceSessionEntry({ ...REQUEST, storePath: f.storePath }, f.entry);
      }
      f.loaded.resolve();
      if (advance !== "replacement" && advance !== "incarnation") {
        await f.waitForCancellationStart(stopping);
      }
      if (advance === "syncing") {
        expect(dispatchSignal?.aborted).toBe(true);
        expect(f.harness.environments.destroy).not.toHaveBeenCalled();
      }
      attached.resolve();
      const result = await stopping;
      if (advance === "replacement" || advance === "incarnation") {
        expect(result).toBeInstanceOf(Error);
        expect(f.cancellationStarted).not.toHaveBeenCalled();
        expect(f.harness.environments.destroy).not.toHaveBeenCalled();
      } else {
        if (action === "archive") {
          expect(result).toBeUndefined();
        }
        expect(action === "archive" ? f.placements.get(REQUEST.sessionId) : result).toMatchObject({
          state: advance === "completed" || advance === "observer" ? "reclaimed" : "local",
        });
        expect(f.cancellationStarted).toHaveBeenCalled();
        expect(f.harness.environments.get(f.harness.ready.environmentId)?.state).toBe("destroyed");
        expect(f.harness.environments.destroy).toHaveBeenCalledOnce();
      }
    } finally {
      f.loaded.resolve();
      provisioned.resolve();
      attached.resolve();
      await Promise.all([dispatch, stopping]);
      f.context.chatRunState.clear();
    }
  },
);

it.each([
  { advance: "cleanup", targetKind: "gateway" },
  { advance: "completed", targetKind: "gateway" },
  { advance: "replacement", targetKind: "gateway" },
  { advance: "cleanup", targetKind: "profile" },
  { advance: "cleanup", targetKind: "device" },
] as const)(
  "Stop retains captured Move completion across cancellation loading ($advance, $targetKind)",
  async ({ advance, targetKind }) => {
    const reconciling = createDeferredCore();
    const reconciled = createDeferredCore();
    const cleaning = createDeferredCore();
    const cleaned = createDeferredCore();
    const f = await cancellationLoadFixture({
      runMoveBarrier: async (request) => await barrier(request),
      afterReconcile: async () => {
        reconciling.resolve();
        await reconciled.promise;
      },
      afterStopTunnel: async () => {
        cleaning.resolve();
        await cleaned.promise;
      },
    });
    const barrier = createGatewayWorkerPlacementMoveBarrier({
      placements: f.placements,
      loadSessionRuntime: async () => f.runtime,
      revokeSessionAuthority: vi.fn(),
    });
    const active = await f.coordinated.dispatch(REQUEST);

    const localGenerations = new Set<number>();
    const moving = f.coordinated
      .move(
        {
          ...REQUEST,
          source: source(active),
          target:
            targetKind === "profile"
              ? { kind: "profile", profileId: "destination-profile" }
              : targetKind === "device"
                ? { kind: "device", deviceId: "destination-device" }
                : { kind: "gateway" },
        },
        (placement) => {
          if (placement.state === "local") {
            localGenerations.add(placement.generation);
          }
        },
      )
      .catch((error: unknown) => error);
    await Promise.race([
      reconciling.promise,
      moving.then(() => {
        throw new Error("Move completed before reconciliation hold");
      }),
    ]);
    expect(f.placements.get(REQUEST.sessionId)?.state).toBe("draining");
    f.cancellationStarted.mockClear();
    f.armCancellation();
    let stopped = false;
    const stopping = f.coordinated.reclaim(REQUEST).then(
      (result) => {
        stopped = true;
        return result;
      },
      (error: unknown) => {
        stopped = true;
        return error;
      },
    );
    try {
      await waitFor(f.loading.promise, stopping);
      reconciled.resolve();
      await Promise.race([
        cleaning.promise,
        moving.then(() => {
          throw new Error("Move completed before cleanup hold");
        }),
      ]);
      expect(f.placements.get(REQUEST.sessionId)?.state).toBe("local");
      if (advance !== "cleanup") {
        cleaned.resolve();
        expect.soft(await moving).toMatchObject({ state: "local" });
      }
      if (advance === "replacement") {
        await f.placements.startDispatch(REQUEST);
      }
      f.loaded.resolve();
      if (advance !== "replacement") {
        await f.waitForCancellationStart(stopping);
      }
      if (advance === "cleanup") {
        expect(f.cancellationStarted).toHaveBeenCalled();
        expect(stopped).toBe(false);
      }
      cleaned.resolve();
      const result = await stopping;
      if (advance === "replacement") {
        expect(result).toBeInstanceOf(Error);
        expect(f.cancellationStarted).not.toHaveBeenCalled();
        expect(f.placements.get(REQUEST.sessionId)?.state).toBe("requested");
      } else {
        expect.soft(result).toMatchObject({ state: "local" });
        expect.soft(await moving).toMatchObject({ state: "local" });
        expect(localGenerations.size).toBe(1);
        expect(f.harness.environments.destroy).toHaveBeenCalledOnce();
        expect.soft(await f.placements.getPlacementMoveAsync(REQUEST.sessionId)).toBeUndefined();
        expect(f.placements.get(REQUEST.sessionId)?.turnClaim).toBeNull();
        expect(await f.placements.listPendingWorkspaceResultsAsync()).toEqual([]);
        expect(f.harness.environments.createWithRequest).toHaveBeenCalledOnce();
        expect(f.harness.log.filter((event) => event === "placement:requested")).toHaveLength(1);
      }
    } finally {
      reconciled.resolve();
      cleaned.resolve();
      f.loaded.resolve();
      await Promise.all([moving, stopping]);
      f.context.chatRunState.clear();
    }
  },
);

it.each(["transaction", "commit"] as const)(
  "retains the abandoned Stop decision when the caller changes at %s completion admission",
  async (stage) => {
    let destroyed = false;
    const f = await cancellationLoadFixture({
      afterDestroy: () => {
        destroyed = true;
      },
    });
    const active = await f.coordinated.dispatch(REQUEST);
    f.harness.markEnvironmentNodeDeviceId("device-1");
    f.database.db
      .prepare("UPDATE worker_environments SET profile_id = ? WHERE environment_id = ?")
      .run("device:device-1", active.environmentId);
    const begun = await f.placements.beginPlacementMove({
      sessionId: active.sessionId,
      source: source(active),
      target: { kind: "gateway" },
      abandonSource: true,
    });
    let allowed = true;
    let admissionReached = false;
    let connected = true;
    const assertLifetime = () => {
      if (!connected) {
        throw new Error("Stop connection closed");
      }
    };
    const assertCaller = () => {
      assertLifetime();
      if (!allowed) {
        throw new Error("Stop caller revoked at completion");
      }
    };
    const authorize = Object.assign(assertCaller, {
      assertWorkerLifetime: assertLifetime,
      assertWorkerGrant: assertCaller,
    });
    const admission = probe.admission(operationAdmission, (request, grant, admit) => {
      if (destroyed && request.stage === stage) {
        admissionReached = true;
        allowed = false;
      }
      admit(request, grant);
    });
    try {
      await expect(f.coordinated.reclaim(REQUEST, authorize)).rejects.toThrow(
        "Stop caller revoked at completion",
      );
      expect(admissionReached).toBe(true);
      expect(f.harness.environments.destroy).toHaveBeenCalledOnce();
      expect(f.placements.get(REQUEST.sessionId)).toMatchObject({ state: "failed" });
      expect((await f.placements.getPlacementMoveAsync(REQUEST.sessionId))?.operationId).toBe(
        begun.intent.operationId,
      );
    } finally {
      connected = false;
      admission.mockRestore();
      f.context.chatRunState.clear();
    }
  },
);
