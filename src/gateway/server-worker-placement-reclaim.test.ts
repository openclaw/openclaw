import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { loadTranscriptEvents, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { clearAgentRunContext } from "../infra/agent-run-registry.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { pendingChatSendDedupeKey } from "./server-shared.js";
import { cancelGatewayWorkerSessionWork } from "./server-worker-placement-cancel.js";
import { createGatewayWorkerDispatchAdmission } from "./server-worker-placement-dispatch-admission.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";
import {
  admitWorkerStopChat,
  createWorkerStopChatContext,
} from "./server-worker-placement.test-harness.js";
import { coordinateWorkerPlacementDispatch } from "./worker-environments/placement-dispatch-coordinator.js";
import { REQUEST } from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { workerWorkspaceResultStaging } from "./worker-environments/workspace-result-staging.js";

const lookup = vi.hoisted(() => ({
  value: undefined as ReturnType<typeof import("./session-utils.js").loadSessionEntry> | undefined,
}));
vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadSessionEntry: () => lookup.value,
}));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: () => ({}),
}));
const roots: string[] = [];
afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
  lookup.value = undefined;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worker-stop-"));
  roots.push(root);
  const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  const placements = createWorkerSessionPlacementStore({ database, now: () => 1000 });
  const readProjection = placements.readProjection.bind(placements);
  const projectionReads = pendingMove ? vi.spyOn(placements, "readProjection") : undefined;
  const storePath = path.join(root, "sessions.sqlite");
  const worktreePath = path.join(root, "workspace");
  await fs.mkdir(worktreePath);
  // Recovery reads real result refs, so this managed-worktree fixture owns its Git root.
  const initialized = await runCommandWithTimeout(["git", "-C", worktreePath, "init", "--quiet"], {
    timeoutMs: 10_000,
  });
  expect(initialized.code).toBe(0);
  const entry = {
    sessionId: REQUEST.sessionId,
    worktree: { id: "task-worktree", branch: "test", repoRoot: worktreePath },
    updatedAt: Date.now(),
  };
  const target = {
    storePath,
    canonicalKey: REQUEST.sessionKey,
    storeKeys: [REQUEST.sessionKey],
    agentId: REQUEST.agentId,
    store: { [REQUEST.sessionKey]: entry },
  };
  lookup.value = { ...target, cfg: {}, entry, legacyKey: undefined };
  await replaceSessionEntry(
    { storePath, sessionKey: REQUEST.sessionKey, agentId: REQUEST.agentId },
    entry,
  );
  const barrierEntered = createDeferred();
  const releaseBarrier = createDeferred();
  const context = createWorkerStopChatContext();
  const cancelApprovals = vi.fn();
  context.cancelRunBoundApprovals = cancelApprovals;
  const revocations: unknown[] = [];
  const cancellationLoad = createDeferred();
  const cancellationEntered = createDeferred();
  let cancellationLoadEntered = false;
  let abortedBeforeCancellationLoad = false;
  const barriers = createGatewayWorkerPlacementReclaimBarriers({
    placements,
    loadSessionRuntime: async () =>
      ({
        managedWorktrees: {
          findLiveByOwner: async () =>
            failedRetry
              ? undefined
              : {
                  id: "task-worktree",
                  ownerId: REQUEST.sessionKey,
                  path: worktreePath,
                },
        },
        resolveGatewaySessionStoreTargetWithStore: () => target,
        resolveCanonicalSessionEntryFromStoreKeys: () => entry,
      }) as never,
    cancelSessionWork: async (request) => {
      cancellationEntered.resolve();
      if (pendingMove) {
        cancellationLoadEntered = true;
        await cancellationLoad.promise;
        const runtime = await import("./server-worker-placement-cancel.js");
        await runtime.cancelGatewayWorkerSessionWork(context, request);
      } else {
        await cancelGatewayWorkerSessionWork(context, request);
      }
    },
    revokeSessionAuthority: (request) => {
      revocations.push(request);
    },
  });
  let reconciliations = 0;
  const harness = await createHarness(database, placements, {
    workspacePath: worktreePath,
    ...(failedRetry ? { failAt: "sync" as const } : {}),
    runReclaimPreparation: barriers.runReclaimPreparation,
    runReclaimBarrier: barriers.runReclaimBarrier,
    runFailedReclaimBarrier: barriers.runFailedReclaimBarrier,
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
      ? createGatewayWorkerDispatchAdmission(
          async () =>
            ({
              managedWorktrees: {
                findLiveByOwner: async () => ({
                  id: "task-worktree",
                  ownerId: REQUEST.sessionKey,
                  path: worktreePath,
                }),
              },
              resolveGatewaySessionStoreTargetWithStore: () => target,
              resolveCanonicalSessionEntryFromStoreKeys: () => entry,
            }) as never,
        )
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
    admitWorkerStopChat({
      context,
      storePath,
      entry,
      sessionKey: REQUEST.sessionKey,
      sessionId: REQUEST.sessionId,
      agentId: REQUEST.agentId,
      runId,
    });
  const oldRunId = name + "-before-stop-complete";
  const running = blockedInspection ? await admit(name + "-running").promise : undefined;
  const activeController = context.chatAbortControllers.get(name + "-running");
  if (pendingMove) {
    context.chatRunState.getOrCreate(name + "-running").buffer = "partial before queued Move Stop";
  }
  let cancellationRecovery: Promise<void> | undefined;
  const runningAborted = createDeferred();
  if (running?.ok) {
    running.value.activeRunAbort.controller.signal.addEventListener("abort", () => {
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
  let moveSettledDuringInspection = false;
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
  let abortReasonDuringInspection: string | undefined;
  let approvalsCancelledDuringInspection = false;
  let abortedDuringInspection = false;
  let destroyedDuringInspection = false;
  let old!: ReturnType<typeof admit>;
  let reclaimResult: { ok: boolean; state?: string; message?: string } | undefined;
  const reserveOld = () => {
    old = admit(oldRunId);
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
    expect(context.chatAbortControllers.has(oldRunId)).toBe(false);
  };
  const stop = async () => {
    const reclaim = coordinated.reclaim(REQUEST).then(
      (value) => {
        return { ok: true, state: value.state };
      },
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
          abortedBeforeCancellationLoad = activeController?.controller.signal.aborted === true;
          cancellationLoad.resolve();
        }
        await awaitGateBeforeSettlement(
          runningAborted.promise,
          reclaim,
          "Stop settled before aborting the running chat with inspection held",
        );
        abortedDuringInspection =
          running?.ok === true && running.value.activeRunAbort.controller.signal.aborted;
        destroyedDuringInspection = vi.mocked(harness.environments.destroy).mock.calls.length > 0;
        abortReasonDuringInspection = activeController?.abortStopReason;
        approvalsCancelledDuringInspection = cancelApprovals.mock.calls.some(
          ([runId]) => runId === name + "-running",
        );
        reserveOld();
        if (moving) {
          await awaitGateBeforeSettlement(
            moving,
            reclaim,
            "Stop settled before the queued Move with inspection held",
          );
        }
        moveSettledDuringInspection = moveSettled;
      } finally {
        cancellationLoad.resolve();
        releaseInspection.resolve();
      }
    }
    if (pendingDispatch) {
      await setImmediate();
      reserveOld();
      releaseProvision.resolve();
      active = await dispatching!;
    }
    await Promise.race([barrierEntered.promise, reclaim]);
    if (!beforeStop && !blockedInspection && !pendingDispatch) {
      reserveOld();
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
    await runExclusiveSessionLifecycleMutation("placement-reclaim", {
      scope: storePath,
      identities: [REQUEST.sessionKey, REQUEST.sessionId],
      run: async () => {
        reserveOld();
        await stop();
      },
    });
  } else {
    await stop();
  }
  const oldResult = await old.promise;
  if (destroyFailure && !failedRetry) {
    expect(oldResult.ok).toBe(false);
    expect(harness.environments.get(active.environmentId!)?.state).toBe("destroying");
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([
      expect.objectContaining({ workspaceAcceptedAtMs: expect.any(Number) }),
    ]);
    await coordinated.reconcileActive();
  }
  const finalPlacement = placements.get(REQUEST.sessionId);
  const environment = harness.environments.get(active.environmentId!);
  expect(environment?.state).toBe("destroyed");
  expect(harness.environments.destroy).toHaveBeenCalledTimes(destroyFailure ? 2 : 1);
  if (oldResult.ok) {
    oldResult.value.cleanupAdmittedRun();
    clearAgentRunContext(oldRunId, oldResult.value.lifecycleGeneration);
  }
  const freshRunId = name + "-explicit-after-stop";
  const fresh = admit(freshRunId);
  const freshResult = await fresh.promise;
  if (freshResult.ok) {
    freshResult.value.cleanupAdmittedRun();
    clearAgentRunContext(freshRunId, freshResult.value.lifecycleGeneration);
  }
  const persistedPartials = pendingMove
    ? (
        await loadTranscriptEvents({
          storePath,
          sessionKey: REQUEST.sessionKey,
          sessionId: REQUEST.sessionId,
          agentId: REQUEST.agentId,
        })
      ).filter(
        (event) =>
          (event as { message?: { idempotencyKey?: string } }).message?.idempotencyKey ===
          name + "-running:assistant",
      )
    : [];
  const report = {
    name,
    destroyFailure,
    beforeStop,
    staged,
    reclaimResult,
    finalPlacementState: finalPlacement?.state,
    environmentState: environment?.state,
    providerDestroyAttempts: vi.mocked(harness.environments.destroy).mock.calls.length,
    pendingWorkspaceResults: (await placements.listPendingWorkspaceResultsAsync()).length,
    preexistingAdmissionAccepted: oldResult.ok,
    preexistingResponses: old.respond.mock.calls,
    explicitNewAdmissionAccepted: freshResult.ok,
    approvalAttachRevocationCount: revocations.length,
    abortedDuringInspection,
    abortReasonDuringInspection,
    cancellationLoadEntered,
    abortedBeforeCancellationLoad,
    approvalsCancelledDuringInspection,
    persistedPartials,
    moveResult: await moving,
    moveSettledDuringInspection,
    destroyedDuringInspection,
    harnessOrder: [...harness.log],
  };
  context.chatRunState.clear();
  if (running?.ok) {
    running.value.cleanupAdmittedRun();
    clearAgentRunContext(name + "-running", running.value.lifecycleGeneration);
  }
  return report;
}

it.each([false, true])(
  "Stop cancels before unrelated inspection releases (recovery=%s)",
  async (cancellationNeedsRecovery) => {
    const r = await scenario(`blocked-inspection-${cancellationNeedsRecovery}`, {
      blockedInspection: true,
      cancellationNeedsRecovery,
    });
    expect(r.abortedDuringInspection).toBe(true);
    expect(r.destroyedDuringInspection).toBe(false);
    expect(r.preexistingAdmissionAccepted).toBe(false);
    expect(r.reclaimResult).toEqual({ ok: true, state: "reclaimed" });
    expect(r.explicitNewAdmissionAccepted).toBe(true);
  },
);

it("Stop fences ingress during provisioning without cancelling its dispatch producer", async () => {
  const r = await scenario("pending-dispatch", { pendingDispatch: true });
  expect(r.preexistingAdmissionAccepted).toBe(false);
  expect(r.reclaimResult).toEqual({ ok: true, state: "reclaimed" });
  expect(r.explicitNewAdmissionAccepted).toBe(true);
});

it("a reservation preceding Stop cannot revive a successfully reclaimed worker", async () => {
  const r = await scenario("pre-stop-reservation", { beforeStop: true });
  expect(r.reclaimResult).toEqual({ ok: true, state: "reclaimed" });
  expect(r.explicitNewAdmissionAccepted).toBe(true);
  expect(r.preexistingAdmissionAccepted).toBe(false);
});
it("accepted staged reclaim recovers provider cleanup but must reject pre-Stop ingress", async () => {
  const r = await scenario("accepted-staged-stop-recovery", {
    destroyFailure: true,
    beforeStop: true,
    staged: true,
  });
  expect(r.reclaimResult).toEqual({ ok: false, message: "destroy pending" });
  expect(r.finalPlacementState).toBe("reclaimed");
  expect(r.pendingWorkspaceResults).toBe(0);
  expect(r.explicitNewAdmissionAccepted).toBe(true);
  expect(r.preexistingAdmissionAccepted).toBe(false);
});

it.each([false, true])(
  "Stop of an already failed placement cancels pending ingress (before=%s)",
  async (beforeStop) => {
    const r = await scenario(`failed-retry-${beforeStop}`, {
      destroyFailure: true,
      beforeStop,
      failedRetry: true,
    });
    expect(r.reclaimResult).toEqual({ ok: true, state: "local" });
    expect(r.environmentState).toBe("destroyed");
    expect(r.providerDestroyAttempts).toBe(2);
    expect(r.explicitNewAdmissionAccepted).toBe(true);
    expect(
      r.preexistingAdmissionAccepted,
      "failed cleanup must not release old pending work into local execution",
    ).toBe(false);
  },
);

it("an idempotent failed-cleanup result does not cancel work already on the local placement", async () => {
  const storePath = path.join(os.tmpdir(), "failed-already-local.sqlite");
  const entry = { sessionId: REQUEST.sessionId, updatedAt: Date.now() };
  const target = {
    storePath,
    canonicalKey: REQUEST.sessionKey,
    storeKeys: [REQUEST.sessionKey],
    agentId: REQUEST.agentId,
    store: { [REQUEST.sessionKey]: entry },
  };
  const local = { state: "local", sessionId: REQUEST.sessionId, generation: 4 };
  const cancel = vi.fn();
  const barriers = createGatewayWorkerPlacementReclaimBarriers({
    placements: {
      get: () => local as never,
      getAsync: async () => local as never,
      waitForTurnClaimRelease: vi.fn(),
    },
    loadSessionRuntime: async () =>
      ({
        managedWorktrees: { findLiveByOwner: async () => undefined },
        resolveGatewaySessionStoreTargetWithStore: () => target,
        resolveCanonicalSessionEntryFromStoreKeys: () => entry,
      }) as never,
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
  const r = await scenario("queued-move-partial", { blockedInspection: true, pendingMove: true });
  expect(r.cancellationLoadEntered).toBe(true);
  expect(r.abortedBeforeCancellationLoad).toBe(false);
  expect(r.abortedDuringInspection).toBe(true);
  expect(r.abortReasonDuringInspection).toBe("rpc");
  expect(r.approvalsCancelledDuringInspection).toBe(true);
  expect(r.destroyedDuringInspection).toBe(false);
  expect(r.moveResult).toMatchObject({ ok: false });
  expect(r.moveSettledDuringInspection).toBe(true);
  expect(r.reclaimResult).toEqual({ ok: true, state: "reclaimed" });
  expect(r.preexistingAdmissionAccepted).toBe(false);
  expect(r.explicitNewAdmissionAccepted).toBe(true);
  expect(r.persistedPartials).toEqual([
    expect.objectContaining({
      message: expect.objectContaining({
        role: "assistant",
        content: [
          expect.objectContaining({ type: "text", text: "partial before queued Move Stop" }),
        ],
        openclawAbort: { aborted: true, origin: "rpc", runId: "queued-move-partial-running" },
      }),
    }),
  ]);
});

it.each(["missing", "local"] as const)(
  "Stop records RPC cancellation for local chat before unrelated inspection completes (%s placement)",
  async (state) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "worker-stop-local-"));
    roots.push(root);
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database });
    const storePath = path.join(root, "sessions.sqlite");
    const entry = { sessionId: REQUEST.sessionId, updatedAt: Date.now() };
    const target = {
      storePath,
      canonicalKey: REQUEST.sessionKey,
      storeKeys: [REQUEST.sessionKey],
      agentId: REQUEST.agentId,
      store: { [REQUEST.sessionKey]: entry },
    };
    lookup.value = { ...target, cfg: {}, entry, legacyKey: undefined };
    await replaceSessionEntry(
      { storePath, sessionKey: REQUEST.sessionKey, agentId: REQUEST.agentId },
      entry,
    );
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
    const sessionRuntime = {
      managedWorktrees: { findLiveByOwner: async () => undefined },
      resolveGatewaySessionStoreTargetWithStore: () => target,
      resolveCanonicalSessionEntryFromStoreKeys: () => entry,
    };
    const context = createWorkerStopChatContext();
    const cancelApprovals = vi.fn();
    context.cancelRunBoundApprovals = cancelApprovals;
    const cancellationLoad = createDeferred();
    const cancellationEntered = createDeferred();
    const cancel = vi.fn(async (request: Parameters<typeof cancelGatewayWorkerSessionWork>[1]) => {
      cancellationEntered.resolve();
      await cancellationLoad.promise;
      const runtime = await import("./server-worker-placement-cancel.js");
      await runtime.cancelGatewayWorkerSessionWork(context, request);
    });
    const barriers = createGatewayWorkerPlacementReclaimBarriers({
      placements,
      loadSessionRuntime: async () => sessionRuntime,
      cancelSessionWork: cancel,
      revokeSessionAuthority: vi.fn(),
    });
    const harness = await createHarness(database, placements, {
      workspacePath: root,
      runReclaimPreparation: barriers.runReclaimPreparation,
      runReclaimBarrier: barriers.runReclaimBarrier,
      runFailedReclaimBarrier: barriers.runFailedReclaimBarrier,
    });
    const coordinated = coordinateWorkerPlacementDispatch(
      harness.service,
      createGatewayWorkerDispatchAdmission(async () => sessionRuntime),
    );
    const runId = `queued-local-${state}`;
    const admitted = await admitWorkerStopChat({ context, storePath, entry, ...REQUEST, runId })
      .promise;
    if (!admitted.ok) {
      throw new Error("Active local chat fixture was not admitted");
    }
    const controller = context.chatAbortControllers.get(runId);
    if (!controller) {
      throw new Error("Active local chat fixture has no controller");
    }
    context.chatRunState.getOrCreate(runId).buffer = "partial before queued dispatch Stop";
    const aborted = createDeferred();
    controller.controller.signal.addEventListener("abort", () => {
      admitted.value.cleanupAdmittedRun();
      aborted.resolve();
    });
    const entered = createDeferred();
    const release = createDeferred();
    vi.mocked(harness.environments.reconcileOnce).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const sweep = coordinated.reconcileActive();
    await entered.promise;
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
      expect(cancel).toHaveBeenCalledOnce();
      expect(controller.controller.signal.aborted).toBe(false);
      cancellationLoad.resolve();
      await awaitGateBeforeSettlement(
        aborted.promise,
        stopping,
        "Stop settled before aborting local chat with inspection held",
      );
      expect(controller.abortStopReason).toBe("rpc");
      expect(cancelApprovals).toHaveBeenCalledWith(runId);
      await stopping;
      expect(dispatchSettled).toBe(true);
      expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
    } finally {
      cancellationLoad.resolve();
      release.resolve();
      await Promise.all([sweep, dispatch, stopping]);
      admitted.value.cleanupAdmittedRun();
      clearAgentRunContext(runId, admitted.value.lifecycleGeneration);
    }
    expect(await dispatch).toBe("cancelled");
    expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    const transcript = await loadTranscriptEvents({ storePath, ...REQUEST });
    expect(transcript.filter((event) => asRecord(event)?.type === "message")).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          role: "assistant",
          content: [
            expect.objectContaining({ type: "text", text: "partial before queued dispatch Stop" }),
          ],
          openclawAbort: { aborted: true, origin: "rpc", runId },
        }),
      }),
    ]);
    context.chatRunState.clear();
  },
);
