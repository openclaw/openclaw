import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadTranscriptEvents, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { runSessionMutation } from "../sessions/session-controller.lifecycle.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { pendingChatSendDedupeKey } from "./server-shared.js";
import { cancelGatewayWorkerSessionWork } from "./server-worker-placement-cancel.js";
import { createGatewayWorkerDispatchAdmission } from "./server-worker-placement-dispatch-admission.js";
import { createPlacementTestHold } from "./server-worker-placement-hold.test-support.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";
import {
  cleanupAdmission,
  sessionRuntime,
  useReclaimFixtures,
} from "./server-worker-placement-reclaim.test-support.js";
import {
  admitWorkerStopChat,
  createWorkerStopChatContext,
} from "./server-worker-placement.test-harness.js";
import { claimRpcSourceForTest } from "./test-helpers.rpc-source.js";
import { coordinateWorkerPlacementDispatch } from "./worker-environments/placement-dispatch-coordinator.js";
import { REQUEST } from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";
import { workerWorkspaceResultStaging } from "./worker-environments/workspace-result-staging.js";

const fixtures = useReclaimFixtures();
function expectPartial(events: unknown[], text: string, runId: string) {
  expect(events).toEqual([
    expect.objectContaining({
      message: expect.objectContaining({
        role: "assistant",
        content: [expect.objectContaining({ type: "text", text })],
        openclawAbort: { aborted: true, origin: "rpc", runId },
      }),
    }),
  ]);
}

async function scenario(
  name: string,
  {
    destroyFailure = false,
    beforeStop = false,
    staged = false,
    failedRetry = false,
    blockedInspection = false,
    cancellationNeedsRecovery = false,
    pendingDispatch = false,
    pendingMove = false,
  } = {},
) {
  const root = fixtures.makeRoot("worker-stop-");
  const worktreePath = path.join(root, "workspace");
  await fs.mkdir(worktreePath);
  // Recovery reads real result refs, so this managed-worktree fixture owns its Git root.
  const initialized = await runCommandWithTimeout(["git", "-C", worktreePath, "init", "--quiet"], {
    timeoutMs: 10_000,
  });
  expect(initialized.code).toBe(0);
  const { database, placements, storePath, entry } = await fixtures.createSession(root, {
    worktreePath,
    now: () => 1000,
  });
  const readProjection = placements.readProjection.bind(placements);
  const projectionReads = pendingMove ? vi.spyOn(placements, "readProjection") : undefined;
  const barrierEntered = createDeferred();
  const releaseBarrier = createDeferred();
  const context = createWorkerStopChatContext();
  const cancelApprovals = vi.fn();
  context.cancelRunBoundApprovals = cancelApprovals;
  const cancellationLoad = createDeferred();
  const cancellationEntered = createDeferred();
  const barriers = createGatewayWorkerPlacementReclaimBarriers({
    placements,
    loadSessionRuntime: async () =>
      sessionRuntime(storePath, failedRetry ? undefined : worktreePath),
    cancelSessionWork: async (request) => {
      cancellationEntered.resolve();
      if (pendingMove) {
        await cancellationLoad.promise;
      }
      await cancelGatewayWorkerSessionWork(context, request);
    },
    revokeSessionAuthority: vi.fn(),
  });
  let reconciliations = 0;
  const harness = await createHarness(database, placements, {
    workspacePath: worktreePath,
    ...(failedRetry ? { failAt: "sync" as const } : {}),
    ...barriers,
    ...(destroyFailure
      ? { destroyFailureCount: 1, destroyFailureState: "destroying" as const }
      : {}),
    afterReconcile: async () => {
      if (++reconciliations === 1 && !failedRetry) {
        barrierEntered.resolve();
        await releaseBarrier.promise;
      }
    },
    afterDestroy: async () => {
      if (failedRetry) {
        barrierEntered.resolve();
        await releaseBarrier.promise;
      }
    },
  });
  if (staged) {
    // Exercise the real staged-result producer and real Git ref settlement in this
    // disposable workspace. No source repository or hand-written Git object is used.
    const originalStartTunnel = harness.environments.startTunnel;
    harness.environments.startTunnel = vi.fn(
      async (...args: Parameters<typeof originalStartTunnel>) => {
        const tunnel = await originalStartTunnel(...args);
        const originalReconcile = tunnel.reconcileWorkspace.bind(tunnel);
        tunnel.reconcileWorkspace = vi.fn<typeof originalReconcile>(async (request) => {
          if (request.source.kind !== "local" || !request.source.stagedResult) {
            throw new Error("Expected a staged local workspace reclaim");
          }
          const { journal, stagedResult } = request.source;
          const result = await originalReconcile(request);
          const raw = JSON.stringify({ version: 1, baseCommit: null, entries: [] });
          const ref = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
          const payloadRoot = path.join(root, "empty-staged-payload");
          await fs.mkdir(payloadRoot, { recursive: true });
          await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
            root: worktreePath,
            stagingRoot: payloadRoot,
            stagedResultRef: stagedResult.ref,
            baseManifestRef: ref,
            currentManifestRef: ref,
            baseManifestRaw: raw,
            currentManifestRaw: raw,
          });
          await stagedResult.record(stagedResult.ref);
          await journal.commit(ref);

          return { ...result, manifestRef: ref, changed: false };
        });
        return tunnel;
      },
    );
  }
  const coordinated = coordinateWorkerPlacementDispatch(
    harness.service,
    pendingMove
      ? createGatewayWorkerDispatchAdmission(async () => sessionRuntime(storePath, worktreePath))
      : (_request, run) => run(),
  );
  const provisionEntered = createDeferred();
  const releaseProvision = createDeferred();
  if (pendingDispatch) {
    vi.mocked(harness.environments.createWithRequest).mockImplementationOnce(async () => {
      provisionEntered.resolve();
      await releaseProvision.promise;
      return harness.ready;
    });
  }
  let dispatching: ReturnType<typeof coordinated.dispatch> | undefined;
  let active;
  if (failedRetry) {
    await expect(coordinated.dispatch(REQUEST)).rejects.toThrow("sync failed");
    active = placements.get(REQUEST.sessionId)!;
    expect(active.state).toBe("failed");
    expect(harness.environments.get(active.environmentId!)?.state).toBe("destroying");
  } else {
    dispatching = coordinated.dispatch(
      blockedInspection ? { ...REQUEST, executionMode: "remote-exec" } : REQUEST,
    );
    if (pendingDispatch) {
      await provisionEntered.promise;
      active = placements.get(REQUEST.sessionId)!;
      expect(active.state).toBe("provisioning");
    } else {
      active = await dispatching;
      expect(active.state).toBe("active");
    }
  }
  const admit = (runId: string) =>
    admitWorkerStopChat({ context, storePath, entry, ...REQUEST, runId });
  const oldRunId = name + "-before-stop-complete";
  const running = blockedInspection ? await (await admit(name + "-running")).promise : undefined;
  const activeController = rpcSourceTesting.get(name + "-running");
  let releaseRunningClaim: (() => void) | undefined;
  if (running?.ok && activeController) {
    releaseRunningClaim = await claimRpcSourceForTest(activeController);
    expect(running.value.activeRunAbort.markExecutionStarted()).toBe(true);
  }
  if (pendingMove) {
    context.chatRunState.getOrCreate(name + "-running").buffer = "partial before queued Move Stop";
  }
  let cancellationRecovery: Promise<void> | undefined;
  const runningAborted = createDeferred();
  if (running?.ok) {
    running.value.activeRunAbort.controller.signal.addEventListener("abort", () => {
      releaseRunningClaim?.();
      releaseRunningClaim = undefined;
      if (cancellationNeedsRecovery) {
        // Real worker failure completion joins placement recovery before releasing admission.
        cancellationRecovery = coordinated.reconcileActive().finally(() => {
          running.value.cleanupAdmittedRun();
        });
      } else {
        running.value.cleanupAdmittedRun();
      }
      runningAborted.resolve();
    });
  }
  const inspectionEntered = createDeferred();
  const releaseInspection = createDeferred();
  if (blockedInspection && projectionReads) {
    projectionReads.mockImplementationOnce(async (...args) => {
      inspectionEntered.resolve();
      await releaseInspection.promise;
      return await readProjection(...args);
    });
  } else if (blockedInspection) {
    vi.mocked(harness.environments.reconcileOnce).mockImplementationOnce(async () => {
      inspectionEntered.resolve();
      await releaseInspection.promise;
    });
  }
  const sweep = blockedInspection
    ? coordinated.reconcileActive(pendingMove ? harness.ready.environmentId : undefined)
    : undefined;
  if (sweep) {
    await inspectionEntered.promise;
  }
  let moving: Promise<{ ok: boolean; error?: unknown }> | undefined;
  let moveSettled = false;
  if (pendingMove) {
    if (active.state !== "active") {
      throw new Error("Queued Move fixture requires an active worker placement");
    }
    moving = coordinated
      .move({
        ...REQUEST,
        source: {
          generation: active.generation,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
        target: { kind: "gateway" },
      })
      .then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      )
      .finally(() => {
        moveSettled = true;
      });
  }
  if (moving) {
    await setImmediate();
    expect(placements.get(REQUEST.sessionId)?.state).toBe("active");
  }
  let old!: Awaited<ReturnType<typeof admit>>;
  let reclaimResult: { ok: boolean; state?: string; message?: string } | undefined;
  const reserveOld = async () => {
    old = await admit(oldRunId);
    if (blockedInspection || pendingDispatch) {
      void old.promise.then((result) => {
        if (result.ok) {
          result.value.cleanupAdmittedRun();
        }
      });
    }
    const reservation = context.dedupe.get(pendingChatSendDedupeKey(oldRunId));
    if (beforeStop) {
      expect((reservation?.payload as { status?: string } | undefined)?.status).toBe("accepted");
    }
    expect(rpcSourceTesting.has(oldRunId)).toBe(false);
  };
  const stop = async () => {
    const reclaim = coordinated.reclaim(REQUEST).then(
      (value) => ({ ok: true, state: value.state }),
      (error: unknown) => {
        if (!(error instanceof Error)) {
          throw error;
        }
        return { ok: false, message: error.message };
      },
    );
    if (blockedInspection) {
      try {
        if (pendingMove) {
          await awaitGateBeforeSettlement(
            cancellationEntered.promise,
            reclaim,
            "Stop settled before entering cancellation with inspection held",
          );
          expect(activeController?.input.abortSignal.aborted).toBe(false);
          cancellationLoad.resolve();
        }
        await awaitGateBeforeSettlement(
          runningAborted.promise,
          reclaim,
          "Stop settled before aborting the running chat with inspection held",
        );
        expect(running?.ok && running.value.activeRunAbort.controller.signal.aborted).toBe(true);
        expect(harness.environments.destroy).not.toHaveBeenCalled();
        await reserveOld();
        if (moving) {
          await awaitGateBeforeSettlement(
            moving,
            reclaim,
            "Stop settled before the queued Move with inspection held",
          );
          expect(moveSettled).toBe(true);
          expect(activeController?.adapter.abortStopReason).toBe("rpc");
          expect(cancelApprovals).toHaveBeenCalledWith(name + "-running");
        }
      } finally {
        cancellationLoad.resolve();
        releaseInspection.resolve();
      }
    }
    if (pendingDispatch) {
      await awaitGateBeforeSettlement(
        cancellationEntered.promise,
        reclaim,
        "Stop settled before fencing provisioning ingress",
      );
      await reserveOld();
      releaseProvision.resolve();
      active = await dispatching!;
    }
    await Promise.race([barrierEntered.promise, reclaim]);
    if (!beforeStop && !blockedInspection && !pendingDispatch) {
      await reserveOld();
    }
    releaseBarrier.resolve();
    reclaimResult = await reclaim;
    await sweep;
    await cancellationRecovery;
    await moving;
  };
  if (beforeStop) {
    // A preceding lifecycle owner holds ingress pending while Stop joins that
    // same owner. This fixes ordering without timer delays or editing ingress.
    await runSessionMutation({
      scope: storePath,
      identities: [REQUEST.sessionKey, REQUEST.sessionId],
      agentId: REQUEST.agentId,
      run: async () => {
        await reserveOld();
        await stop();
      },
    });
  } else {
    await stop();
  }
  const oldResult = await old.promise;
  expect(oldResult.ok).toBe(false);
  if (destroyFailure && !failedRetry) {
    expect(harness.environments.get(active.environmentId!)?.state).toBe("destroying");
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([
      expect.objectContaining({ workspaceAcceptedAtMs: expect.any(Number) }),
    ]);
    await coordinated.reconcileActive();
  }
  const environment = harness.environments.get(active.environmentId!);
  expect(environment?.state).toBe("destroyed");
  expect(reclaimResult).toEqual(
    failedRetry
      ? { ok: true, state: "local" }
      : destroyFailure
        ? { ok: false, message: "destroy pending" }
        : { ok: true, state: "reclaimed" },
  );
  if (staged) {
    expect(placements.get(REQUEST.sessionId)?.state).toBe("reclaimed");
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
  }
  cleanupAdmission(oldRunId, oldResult);
  const freshRunId = name + "-explicit-after-stop";
  const fresh = await admit(freshRunId);
  const freshResult = await fresh.promise;
  expect(freshResult.ok).toBe(true);
  cleanupAdmission(freshRunId, freshResult);
  if (pendingMove) {
    expect(await moving).toMatchObject({ ok: false });
    expectPartial(
      (await loadTranscriptEvents({ storePath, ...REQUEST })).filter(
        (event) =>
          (event as { message?: { idempotencyKey?: string } }).message?.idempotencyKey ===
          name + "-running:assistant",
      ),
      "partial before queued Move Stop",
      name + "-running",
    );
  }
  context.chatRunState.clear();
  releaseRunningClaim?.();
  cleanupAdmission(name + "-running", running);
}

it.each([false, true])(
  "Stop cancels before unrelated inspection releases (recovery=%s)",
  async (cancellationNeedsRecovery) => {
    await scenario(`blocked-inspection-${cancellationNeedsRecovery}`, {
      blockedInspection: true,
      cancellationNeedsRecovery,
    });
  },
);

it("Stop fences ingress during provisioning without cancelling its dispatch producer", async () => {
  await scenario("pending-dispatch", { pendingDispatch: true });
});

it("a reservation preceding Stop cannot revive a successfully reclaimed worker", async () => {
  await scenario("pre-stop-reservation", { beforeStop: true });
});
it("accepted staged reclaim recovers provider cleanup but must reject pre-Stop ingress", async () => {
  await scenario("accepted-staged-stop-recovery", {
    destroyFailure: true,
    beforeStop: true,
    staged: true,
  });
});

it.each([false, true])(
  "Stop of an already failed placement cancels pending ingress (before=%s)",
  async (beforeStop) => {
    await scenario(`failed-retry-${beforeStop}`, {
      destroyFailure: true,
      beforeStop,
      failedRetry: true,
    });
  },
);

it("an idempotent failed-cleanup result does not cancel work already on the local placement", async () => {
  const storePath = path.join(fixtures.makeRoot("failed-already-local-"), "sessions.sqlite");
  setRuntimeConfigSnapshot({ session: { store: storePath } });
  const entry = { sessionId: REQUEST.sessionId, updatedAt: Date.now() };
  await replaceSessionEntry({ ...REQUEST, storePath }, entry);
  const local = { state: "local", sessionId: REQUEST.sessionId, generation: 4 };
  const cancel = vi.fn();
  const barriers = createGatewayWorkerPlacementReclaimBarriers({
    placements: {
      get: () => local as never,
      getAsync: async () => local as never,
      waitForTurnClaimRelease: vi.fn(),
    },
    loadSessionRuntime: async () => sessionRuntime(storePath),
    cancelSessionWork: cancel,
    revokeSessionAuthority: vi.fn(),
  });
  const reclaimed = await barriers.runFailedReclaimBarrier({
    ...REQUEST,
    reclaim: async () => local,
  } as never);
  expect(reclaimed).toBe(local);
  expect(cancel).not.toHaveBeenCalled();
});

it("Stop preserves RPC cancellation and buffered output while Move waits behind same-session recovery", async () => {
  await scenario("queued-move-partial", { blockedInspection: true, pendingMove: true });
});

it.each(["missing", "local"] as const)(
  "Stop records RPC cancellation for local chat before unrelated inspection completes (%s placement)",
  async (state) => {
    const root = fixtures.makeRoot("worker-stop-local-");
    const {
      database,
      placements,
      storePath,
      entry,
      runtime: localRuntime,
    } = await fixtures.createSession(root);
    if (state === "local") {
      await placements.releaseTurn(
        await placements.claimTurn({
          ...REQUEST,
          owner: { kind: "local" },
          claimId: "seed",
          runId: "seed",
        }),
      );
    }
    const context = createWorkerStopChatContext();
    const cancelApprovals = vi.fn();
    context.cancelRunBoundApprovals = cancelApprovals;
    const cancellationLoad = createDeferred();
    const cancellationEntered = createDeferred();
    const cancel = vi.fn(async (request: Parameters<typeof cancelGatewayWorkerSessionWork>[1]) => {
      cancellationEntered.resolve();
      await cancellationLoad.promise;
      await cancelGatewayWorkerSessionWork(context, request);
    });
    const barriers = createGatewayWorkerPlacementReclaimBarriers({
      placements,
      loadSessionRuntime: async () => localRuntime,
      cancelSessionWork: cancel,
      revokeSessionAuthority: vi.fn(),
    });
    const harness = await createHarness(database, placements, {
      workspacePath: root,
      ...barriers,
    });
    const coordinated = coordinateWorkerPlacementDispatch(
      harness.service,
      createGatewayWorkerDispatchAdmission(async () => localRuntime),
    );
    const runId = `queued-local-${state}`;
    const admitted = await (
      await admitWorkerStopChat({ context, storePath, entry, ...REQUEST, runId })
    ).promise;
    if (!admitted.ok) {
      throw new Error("Active local chat fixture was not admitted");
    }
    const controller = rpcSourceTesting.get(runId);
    if (!controller) {
      throw new Error("Active local chat fixture has no controller");
    }
    const releaseControllerClaim = await claimRpcSourceForTest(controller);
    expect(admitted.value.activeRunAbort.markExecutionStarted()).toBe(true);
    context.chatRunState.getOrCreate(runId).buffer = "partial before queued dispatch Stop";
    const aborted = createDeferred();
    controller.input.abortSignal.addEventListener("abort", () => {
      releaseControllerClaim();
      admitted.value.cleanupAdmittedRun();
      aborted.resolve();
    });
    const entered = createPlacementTestHold();
    vi.mocked(harness.environments.reconcileOnce).mockImplementationOnce(async () => {
      await entered.wait();
    });
    const sweep = coordinated.reconcileActive();
    await entered.entered.promise;
    expect((await placements.getAsync(REQUEST.sessionId))?.state).toBe(
      state === "local" ? "local" : undefined,
    );
    let dispatchSettled = false;
    const dispatch = coordinated
      .dispatch(REQUEST)
      .then(
        () => "active",
        () => "cancelled",
      )
      .finally(() => {
        dispatchSettled = true;
      });
    const stopping = coordinated.reclaim(REQUEST).catch(() => undefined);
    try {
      await awaitGateBeforeSettlement(
        cancellationEntered.promise,
        stopping,
        "Stop settled before entering local chat cancellation with inspection held",
      );
      expect(controller.input.abortSignal.aborted).toBe(false);
      cancellationLoad.resolve();
      await awaitGateBeforeSettlement(
        aborted.promise,
        stopping,
        "Stop settled before aborting local chat with inspection held",
      );
      expect(controller.adapter.abortStopReason).toBe("rpc");
      expect(cancelApprovals).toHaveBeenCalledWith(runId);
      await stopping;
      expect(dispatchSettled).toBe(true);
      expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
    } finally {
      cancellationLoad.resolve();
      entered.release.resolve();
      await Promise.all([sweep, dispatch, stopping]);
      releaseControllerClaim();
      cleanupAdmission(runId, admitted);
    }
    expect(await dispatch).toBe("cancelled");
    expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    const transcript = await loadTranscriptEvents({ storePath, ...REQUEST });
    expectPartial(
      transcript.filter((event) => asRecord(event)?.type === "message"),
      "partial before queued dispatch Stop",
      runId,
    );
    context.chatRunState.clear();
  },
);
