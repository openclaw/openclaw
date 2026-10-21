import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { abortEmbeddedAgentRun } from "../../agents/embedded-agent-runner/runs.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import {
  getDiagnosticSessionActivitySnapshot,
  resetDiagnosticRunActivityForTest,
} from "../../logging/diagnostic-run-activity.js";
import {
  GatewayDrainingError,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { waitForSessionRunEnd } from "../../sessions/session-controller.native-runtime.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { STALE_WORKER_BUILD_REASON, StaleWorkerBuildError } from "./admission.js";
import { placementTurnOwner } from "./placement-record.js";
import { publishPlacementTurnClaimState } from "./placement-turn-authority.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { createProviderReplayDispatch } from "./provider-replay.test-support.js";
import {
  WorkerRuntimeRefreshPendingError,
  type WorkerRuntimeRefreshInFlight,
} from "./provider-runtime-refresh.js";
import {
  WorkerTunnelOwnerDisconnectedError,
  type WorkerTurnTunnelHandle,
} from "./tunnel-contract.js";
import * as worker from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { createWorkerWorkspaceRecoveryFixture } from "./workspace-recovery.test-support.js";

afterAll(closeStateDatabaseForTest);

const refreshedBundleHash = "b".repeat(64);
const replacementReply = "Continued on the replacement worker";
const localResult = async () => ({ meta: { durationMs: 1 } });
const unexpected = (operation: string) => async (): Promise<never> => {
  throw new Error(`unexpected ${operation}`);
};
const disconnected = () =>
  new WorkerTunnelOwnerDisconnectedError(
    "device worker node is not connected with the supervisor dialect",
  );
const completedTunnel = (launchTurn: WorkerTurnTunnelHandle["launchTurn"]) =>
  worker.createWorkerTurnTunnel({
    quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
    launchTurn,
    syncWorkspace: vi.fn(),
    reconcileWorkspace: worker.reconcileUnchangedLocalWorkspace,
    stop: async () => {},
  });

function expectCalls(count: number, ...mocks: { mock: { calls: unknown[] } }[]) {
  for (const mock of mocks) {
    expect(mock.mock.calls).toHaveLength(count);
  }
}

function expectNoClaim() {
  expect(worker.placements.get(worker.SESSION_ID)?.turnClaim).toBeNull();
}

function activePlacement() {
  const placement = worker.placements.get(worker.SESSION_ID);
  if (placement?.state !== "active") {
    throw new Error("fixture requires an active placement");
  }
  return placement;
}

function nodeWait(assertUnclaimed = false) {
  const waiting = createDeferred();
  const reconnect = createDeferred();
  let signal: AbortSignal | undefined;
  const waitForAdmissionNode = vi.fn<worker.WorkerTurnLauncherOptions["waitForAdmissionNode"]>(
    async (params) => {
      signal = params.signal;
      if (assertUnclaimed) {
        params.assertCurrent();
        expectNoClaim();
      }
      waiting.resolve();
      await racePromiseWithAbortSignal(reconnect.promise, signal);
      params.assertCurrent();
    },
  );
  return {
    waiting: waiting.promise,
    reconnect,
    waitForAdmissionNode,
    get signal() {
      return signal;
    },
  };
}

async function expectSinglePersistedInput() {
  expect(
    (await worker.openSessionManager())
      .buildSessionContext()
      .messages.filter((message) => message.role === "user"),
  ).toHaveLength(1);
}

function refreshPlacementBundle(bundleHash: string) {
  const placement = activePlacement();
  // The mock refresh owns this write, including the postimage published by a real refresh.
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.prepare(
        "UPDATE worker_session_placements SET worker_bundle_hash = ? WHERE session_id = ?",
      ).run(bundleHash, worker.SESSION_ID);
      publishPlacementTurnClaimState(db, { ...placement, workerBundleHash: bundleHash });
    },
    { database: worker.database },
  );
}

async function createBuildRecoveryHarness(
  options: {
    rejection?:
      | "recorded"
      | "admission"
      | "pending refresh"
      | "disconnected"
      | "handoff"
      | "interrupted";
    repeated?: boolean;
    pendingResult?: boolean;
    refreshInPlace?: boolean;
    afterReconcile?: () => void | Promise<void>;
    waitForAdmissionNode?: worker.WorkerTurnLauncherOptions["waitForAdmissionNode"];
    replyOperation?: ReplyOperation;
    duringRetryPreparation?: () => void;
  } = {},
) {
  await worker.seedActivePlacement();
  const rejection = options.rejection ?? "admission";
  const gate = createWorkerSessionPlacementGate(worker.placements);
  let environment = worker.attachedEnvironment();
  let connected = rejection !== "interrupted";
  if (rejection === "interrupted") {
    environment = { ...environment, nodeDeviceId: "retained-node" };
    await worker.placements.claimTurn({
      ...worker.sessionTarget,
      claimId: "interrupted-claim",
      runId: "interrupted-run",
      owner: placementTurnOwner(activePlacement()),
    });
  }
  const retire = () => {
    environment = {
      ...environment,
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      sharedHost: null,
      ownerEpoch: worker.OWNER_EPOCH + 1,
      attachedSessionIds: [],
      tunnelStatus: "stopped",
      error: STALE_WORKER_BUILD_REASON,
    };
  };
  if (rejection === "recorded") {
    retire();
  }
  let replaced = false;
  const launchTurn = vi.fn<WorkerTurnTunnelHandle["launchTurn"]>(async (request) => {
    request.onDispatchReady?.();
    if (rejection === "handoff") {
      throw new StaleWorkerBuildError();
    }
    const leafId = await worker.appendWorkerReply(replacementReply, 51);
    return worker.acknowledgeCompletedWorkerTurn(request.turnClaim, leafId);
  });
  const destroy = vi.fn(async () => environment);
  const environments: worker.WorkerTurnEnvironmentService &
    Parameters<typeof createProviderReplayDispatch>[0]["environments"] = {
    ...worker.unusedEnvironments(),
    fenceWorkerTurnForRecovery: gate.fenceWorkerTurnForRecovery,
    prepareProjectIntent: unexpected("prepared intent"),
    assertPreparedIntentCurrent: vi.fn(),
    getPreparedCandidates: () => [],
    schedulePreparedRefill: vi.fn(),
    bindPreparedWorkspace: unexpected("prepared binding"),
    recordError: vi.fn(() => {
      throw new Error("unexpected provisioning interruption");
    }),
    supportsProviderExecutionMode: vi.fn(() => true),
    get: () => environment,
    acquireTurnCredential: async (claim) => {
      if (options.pendingResult) {
        await worker.placements.markWorkspaceResultPending(claim);
      }
      return worker.credential();
    },
    acknowledgeCredentialDelivery: vi.fn(async () => true),
    startTunnel: async () => {
      if (
        rejection !== "handoff" &&
        rejection !== "interrupted" &&
        (!replaced || options.repeated)
      ) {
        if (rejection === "disconnected") {
          throw disconnected();
        }
        if (rejection === "pending refresh") {
          throw new WorkerRuntimeRefreshPendingError("node was disconnected during startup");
        }
        throw new StaleWorkerBuildError();
      }
      return completedTunnel(launchTurn);
    },
    stopTunnel: vi.fn(async () => {
      if (!connected) {
        throw disconnected();
      }
    }),
    destroy,
    requestDestroy: destroy,
    attachSession: vi.fn(unexpected("worker session attachment")),
    createWithRequest: vi.fn(unexpected("worker environment creation")),
    reconcileOnce: async () => {
      if (rejection !== "interrupted") {
        retire();
      }
    },
    reconcileEnvironment: vi.fn(),
  };
  const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
  const dispatch = createProviderReplayDispatch({
    initialPlacements: await worker.placements.listAsync(),
    placements: worker.placements,
    environments,
    runRecoveryBarrier: async ({ run }) => await run({ kind: "local", path: worker.root }),
    runReclaimBarrier: async ({ begin, reclaim }) =>
      await reclaim({ kind: "local", path: worker.root }, await begin()),
    workspaceOperations,
    ...createWorkerWorkspaceRecoveryFixture({
      resolveWorkspace: async () => ({ kind: "local", path: worker.root }),
    }),
  });
  if (rejection === "interrupted") {
    await dispatch.reconcile("startup");
  }
  const redispatchPlacement = vi.fn(async () => {
    replaced = true;
    environment = worker.attachedEnvironment();
    await worker.seedActivePlacement();
    return activePlacement();
  });
  let workspacePreparations = 0;
  const provider = worker.createWorkerSessionTurnPlacementProvider({
    environments,
    placements: worker.placements,
    isInterruptedTurn: dispatch.isInterruptedTurn,
    waitForAdmissionNode: async (params) => {
      await options.waitForAdmissionNode?.(params);
      connected = true;
      if (rejection === "disconnected") {
        replaced = true;
      }
    },
    resolveWorkspace: async () => {
      if (++workspacePreparations === 2) {
        options.duringRetryPreparation?.();
      }
      return { kind: "local", path: worker.root };
    },
    reconcileActivePlacement: async (environmentId) => {
      if (!options.pendingResult) {
        if (options.refreshInPlace) {
          const refresh = await gate.prepareWorkerRuntimeRefresh({
            sessionId: worker.SESSION_ID,
            environmentId,
            ownerEpoch: worker.OWNER_EPOCH,
          });
          refresh.assertCurrent();
          refresh.release();
          environment = {
            ...environment,
            bootstrapReceipt: { ...environment.bootstrapReceipt!, bundleHash: refreshedBundleHash },
          };
          refreshPlacementBundle(refreshedBundleHash);
          replaced = true;
        } else {
          await dispatch.reconcileActive(environmentId);
        }
      }
      await options.afterReconcile?.();
    },
    redispatchPlacement,
    workspaceOperations,
  });
  const runId = "run-build-recovery";
  const input = worker.turn(runId);
  const recorder = createUserTurnTranscriptRecorder({
    target: { ...worker.sessionTarget, sessionEntry: undefined },
    input: { text: input.prompt },
  });
  const originalClaimIds: string[] = [];
  const onAdmitted = vi.fn(() => {
    const claim = worker.placements.get(worker.SESSION_ID)?.turnClaim;
    if (!claim) {
      throw new Error("admitted turn has no claim");
    }
    originalClaimIds.push(claim.claimId);
  });
  const runLocal = vi.fn(localResult);
  return {
    environments,
    launchTurn,
    redispatchPlacement,
    onAdmitted,
    originalClaimIds,
    runLocal,
    reclaim: () =>
      dispatch.reclaim({
        sessionId: worker.SESSION_ID,
        sessionKey: worker.SESSION_KEY,
        agentId: "main",
      }),
    execute: (abortSignal?: AbortSignal, assertRunCurrent?: () => void) =>
      provider.executeTurn(
        worker.workerTurnRequest(runId),
        {
          ...input,
          ...(options.replyOperation ? { replyOperation: options.replyOperation } : {}),
          userTurnTranscriptRecorder: recorder,
          ...(abortSignal ? { abortSignal } : {}),
        },
        runLocal,
        onAdmitted,
        assertRunCurrent,
      ),
  };
}

beforeEach(worker.setupWorkerTurnLauncherTest);
afterEach(() => worker.cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));
afterEach(() => {
  resetGatewayWorkAdmission();
  resetDiagnosticRunActivityForTest();
});

it("waits for reconnect and settles the exact interrupted claim before the next turn", async () => {
  const wait = nodeWait();
  const harness = await createBuildRecoveryHarness({
    rejection: "interrupted",
    waitForAdmissionNode: wait.waitForAdmissionNode,
  });
  const execution = harness.execute();
  try {
    await Promise.race([wait.waiting, execution]);
    expect(worker.placements.get(worker.SESSION_ID)?.turnClaim?.claimId).toBe("interrupted-claim");
    expect(harness.launchTurn).not.toHaveBeenCalled();
    wait.reconnect.resolve();
    await expect(execution).resolves.toMatchObject({
      payloads: [{ text: replacementReply }],
    });
    expect(harness.launchTurn).toHaveBeenCalledOnce();
    expectCalls(0, harness.redispatchPlacement, harness.runLocal);
    await expectSinglePersistedInput();
  } finally {
    wait.reconnect.resolve();
    await execution.catch(() => {});
  }
});

async function createRefreshWaitHarness(fence = false) {
  await worker.seedActivePlacement();
  const settled = createDeferred();
  const reachedAdmission = createDeferred();
  const listeners = new Set<() => void>();
  let environment = worker.attachedEnvironment();
  let inFlight = true;
  let reads = 0;
  const refresh: WorkerRuntimeRefreshInFlight = {
    settled: settled.promise,
    onProgress(listener) {
      listeners.add(listener);
      reachedAdmission.resolve();
      return () => listeners.delete(listener);
    },
  };
  const launchTurn = vi.fn<WorkerTurnTunnelHandle["launchTurn"]>(async (request) => {
    request.onDispatchReady?.();
    const leafId = await worker.appendWorkerReply("Ran on the refreshed worker", 51);
    return worker.acknowledgeCompletedWorkerTurn(request.turnClaim, leafId);
  });
  const acquireTurnCredential = vi.fn(async () => {
    // This boundary also wakes the negative control on the original launcher.
    reachedAdmission.resolve();
    return { ...worker.credential(), bundleHash: environment.bootstrapReceipt!.bundleHash };
  });
  const environments: worker.WorkerTurnEnvironmentService = {
    ...worker.unusedEnvironments(),
    get: () => environment,
    readRuntimeRefresh: () => (inFlight && (!fence || ++reads > 1) ? refresh : undefined),
    acquireTurnCredential,
    acknowledgeCredentialDelivery: vi.fn(async () => true),
    startTunnel: async () => completedTunnel(launchTurn),
  };
  const claimTurn = vi.spyOn(worker.placements, "claimTurn");
  const provider = worker.createWorkerSessionTurnPlacementProvider({
    placements: worker.placements,
    environments,
  });
  const input = worker.turn();
  const onAdmitted = vi.fn();
  return {
    acquireTurnCredential,
    claimTurn,
    launchTurn,
    listeners,
    onAdmitted,
    reachedAdmission: reachedAdmission.promise,
    progress() {
      expectNoClaim();
      for (const listener of listeners) {
        listener();
      }
    },
    finishRefresh() {
      expectNoClaim();
      environment = {
        ...environment,
        bootstrapReceipt: { ...environment.bootstrapReceipt!, bundleHash: refreshedBundleHash },
      };
      refreshPlacementBundle(refreshedBundleHash);
      inFlight = false;
      settled.resolve();
    },
    cleanup() {
      inFlight = false;
      settled.resolve();
      input.preparedRunAdmission.close();
    },
    execute: (signal: AbortSignal) =>
      withSessionTurn(
        {
          sessionId: worker.SESSION_ID,
          sessionKey: worker.SESSION_KEY,
          storePath: worker.sessionTarget.storePath,
          abortSignal: signal,
        },
        async (operation, turnSignal) => {
          return provider.executeTurn(
            worker.workerTurnRequest(input.runId),
            { ...input, replyOperation: operation, abortSignal: turnSignal },
            vi.fn(localResult),
            onAdmitted,
          );
        },
      ),
  };
}

it.each(["before claim", "at claim fence", "Stop", "Gateway restart"] as const)(
  "settles an in-flight runtime refresh wait: %s",
  async (outcome) => {
    const fence = outcome === "at claim fence";
    const harness = await createRefreshWaitHarness(fence);
    const controller = new AbortController();
    const execution = harness.execute(controller.signal);
    const result = execution.catch((error: unknown) => error);
    try {
      await Promise.race([harness.reachedAdmission, execution]);
      if (outcome === "Stop" || outcome === "Gateway restart") {
        expect(harness.listeners.size).toBe(1);
        if (outcome === "Stop") {
          const stopped = new Error("turn stopped during runtime refresh");
          controller.abort(stopped);
          expect(await result).toBe(stopped);
        } else {
          markGatewayRestartDraining();
          expect(await result).toBeInstanceOf(GatewayDrainingError);
          await expect(execution).rejects.toThrow(
            "Gateway is restarting. Please try again shortly.",
          );
        }
        expectCalls(0, harness.claimTurn);
      } else {
        expectNoClaim();
        expectCalls(0, harness.acquireTurnCredential, harness.onAdmitted, harness.launchTurn);
        expect(harness.claimTurn).toHaveBeenCalledTimes(fence ? 1 : 0);
        harness.progress();
        expect(
          getDiagnosticSessionActivitySnapshot({
            sessionId: worker.SESSION_ID,
            sessionKey: worker.SESSION_KEY,
          }).lastProgressReason,
        ).toBe("worker:runtime_refresh");
        harness.finishRefresh();
        await expect(execution).resolves.toMatchObject({
          payloads: [{ text: "Ran on the refreshed worker" }],
        });
        await waitForSessionRunEnd(worker.SESSION_ID, null);
        expect(harness.claimTurn).toHaveBeenCalledTimes(fence ? 2 : 1);
        expectCalls(1, harness.acquireTurnCredential, harness.onAdmitted, harness.launchTurn);
        expect(harness.launchTurn.mock.calls[0]?.[0].plan.admission.handshake.bundleHash).toBe(
          refreshedBundleHash,
        );
      }
      expectNoClaim();
      if (outcome === "Stop" || outcome === "Gateway restart") {
        expectCalls(0, harness.acquireTurnCredential, harness.onAdmitted, harness.launchTurn);
      }
      expect(harness.listeners.size).toBe(0);
    } finally {
      controller.abort();
      await result;
      harness.cleanup();
    }
  },
);

// A runtime refresh holds the environment lock that credential acquisition queues on.
// Stuck-session recovery then cancels the admitted turn before that lock is released.
async function cancelTurnWhileCredentialQueued() {
  await worker.seedActivePlacement();
  const queued = createDeferred();
  const lockedCredential = createDeferred<ReturnType<typeof worker.credential>>();
  const startTunnel = vi.fn<worker.WorkerTurnEnvironmentService["startTunnel"]>(async () => {
    throw new WorkerRuntimeRefreshPendingError(
      "Worker runtime refresh is waiting for the current turn to finish",
    );
  });
  const provider = worker.createWorkerSessionTurnPlacementProvider({
    placements: worker.placements,
    environments: {
      ...worker.unusedEnvironments(),
      get: worker.attachedEnvironment,
      acquireTurnCredential: () => {
        queued.resolve();
        return lockedCredential.promise;
      },
      startTunnel,
    },
  });
  const input = worker.turn();
  const execution = provider.executeTurn(
    worker.workerTurnRequest(input.runId),
    input,
    vi.fn(localResult),
  );
  await Promise.race([queued.promise, execution]);
  expect(worker.placements.get(worker.SESSION_ID)?.turnClaim).not.toBeNull();
  expect(abortEmbeddedAgentRun(worker.SESSION_ID)).toBe(true);
  return { execution, lockedCredential, startTunnel };
}

it.each(["granted", "refused"] as const)(
  "settles cancellation before a queued credential is %s",
  async (outcome) => {
    const { execution, lockedCredential, startTunnel } = await cancelTurnWhileCredentialQueued();
    if (outcome === "granted") {
      lockedCredential.resolve(worker.credential());
    } else {
      lockedCredential.reject(new Error("Worker turn credential claim is not authoritative"));
    }
    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(startTunnel).not.toHaveBeenCalled();
    expectNoClaim();
  },
);

it.each(["backend", "reply"] as const)(
  "accepts Stop through the %s owner between refresh and retry preparation",
  async (cancellation) => {
    await withSessionTurn(
      {
        sessionKey: worker.SESSION_KEY,
        sessionId: worker.SESSION_ID,
        storePath: worker.sessionTarget.storePath,
      },
      async (operation) => {
        if (!operation) {
          throw new Error("Expected an admitted controller operation");
        }
        const duringRetryPreparation = vi.fn(() => {
          expect(
            cancellation === "reply"
              ? operation.abortByUser()
              : abortEmbeddedAgentRun(worker.SESSION_ID),
          ).toBe(true);
        });
        const harness = await createBuildRecoveryHarness({
          rejection: "pending refresh",
          refreshInPlace: true,
          replyOperation: operation,
          duringRetryPreparation,
        });
        await expect(harness.execute(operation.abortSignal)).rejects.toThrow();
        expect(duringRetryPreparation).toHaveBeenCalledOnce();
        expect(operation.abortSignal.aborted).toBe(true);
        expect(harness.launchTurn).not.toHaveBeenCalled();
        expectNoClaim();
      },
    );
  },
);

it.each([
  { rejection: "pending refresh", outcome: "reconnected" },
  { rejection: "disconnected", outcome: "reconnected" },
  { rejection: "pending refresh", outcome: "cancelled" },
  { rejection: "pending refresh", outcome: "backend-cancelled" },
  { rejection: "pending refresh", outcome: "superseded" },
] as const)(
  "retains the original submission through $rejection while availability is $outcome",
  async ({ rejection, outcome }) => {
    const wait = nodeWait(true);
    const controller = new AbortController();
    let current = true;
    const harness = await createBuildRecoveryHarness({
      rejection,
      refreshInPlace: true,
      waitForAdmissionNode: wait.waitForAdmissionNode,
    });
    const before = harness.environments.get(worker.ENVIRONMENT_ID);
    const execution = harness.execute(controller.signal, () => {
      if (!current) {
        throw new Error("original run superseded");
      }
    });
    const result = execution.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await Promise.race([wait.waiting, execution]);
      expect(harness.launchTurn).not.toHaveBeenCalled();
      expect(wait.waitForAdmissionNode).toHaveBeenCalledOnce();
      if (outcome === "cancelled") {
        controller.abort(new Error("original turn cancelled"));
        expect(wait.signal?.aborted).toBe(true);
      } else if (outcome === "backend-cancelled") {
        expect(abortEmbeddedAgentRun(worker.SESSION_ID)).toBe(true);
        expect(wait.signal?.aborted).toBe(true);
      } else {
        current = outcome !== "superseded";
        wait.reconnect.resolve();
      }
      const settled = await result;
      if (outcome === "reconnected") {
        expect(settled).toHaveProperty("value");
        await waitForSessionRunEnd(worker.SESSION_ID, null);
        expect(harness.launchTurn).toHaveBeenCalledOnce();
        await expectSinglePersistedInput();
      } else {
        expect(settled).toHaveProperty("error");
        expect(harness.launchTurn).not.toHaveBeenCalled();
        expect(harness.environments.get(worker.ENVIRONMENT_ID)).toEqual(before);
      }
      expect(harness.redispatchPlacement).not.toHaveBeenCalled();
      expectNoClaim();
    } finally {
      wait.reconnect.resolve();
      await result;
    }
  },
);

it("bounds reconnect admission by the caller's timeout", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const wait = nodeWait();
  const harness = await createBuildRecoveryHarness({
    rejection: "pending refresh",
    refreshInPlace: true,
    waitForAdmissionNode: wait.waitForAdmissionNode,
  });
  const execution = harness.execute();
  const result = execution.catch((error: unknown) => error);
  try {
    await wait.waiting;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toBeInstanceOf(Error);
    expectCalls(0, harness.launchTurn, harness.redispatchPlacement);
    expectNoClaim();
  } finally {
    wait.reconnect.resolve();
    await result;
    vi.useRealTimers();
  }
});

it.each([
  { rejection: "admission", refreshInPlace: true },
  { rejection: "pending refresh", refreshInPlace: true },
  { rejection: "recorded", refreshInPlace: false },
  { rejection: "admission", refreshInPlace: false },
] as const)(
  "continues the same turn after $rejection (refreshInPlace=$refreshInPlace)",
  async ({ rejection, refreshInPlace }) => {
    const harness = await createBuildRecoveryHarness({ rejection, refreshInPlace });
    const before = worker.placements.get(worker.SESSION_ID);
    const result = await harness.execute(refreshInPlace ? undefined : new AbortController().signal);
    expect(result.payloads).toEqual([{ text: replacementReply }]);
    await waitForSessionRunEnd(worker.SESSION_ID, null);
    expectCalls(refreshInPlace ? 0 : 1, harness.redispatchPlacement);
    expectCalls(1, harness.launchTurn, harness.onAdmitted);
    expect(harness.launchTurn.mock.calls[0]?.[0].turnClaim.claimId).not.toBe(
      harness.originalClaimIds[0],
    );
    expect(worker.placements.get(worker.SESSION_ID)).toMatchObject({
      state: "active",
      turnClaim: null,
      ...(refreshInPlace
        ? {
            environmentId: before?.environmentId,
            activeOwnerEpoch: before?.activeOwnerEpoch,
            generation: before?.generation,
            workerBundleHash: refreshedBundleHash,
          }
        : { terminalReason: null, recoveryError: null }),
    });
    if (refreshInPlace) {
      expect(harness.environments.destroy).not.toHaveBeenCalled();
    }
    expect(harness.runLocal).not.toHaveBeenCalled();
    await expectSinglePersistedInput();
  },
);

it.each([
  { outcome: "cancelled", refreshInPlace: false },
  { outcome: "superseded", refreshInPlace: true },
  { outcome: "replaced", refreshInPlace: false },
  { outcome: "replaced", refreshInPlace: true },
] as const)(
  "does not retry a turn $outcome during reconciliation (refreshInPlace=$refreshInPlace)",
  async ({ outcome, refreshInPlace }) => {
    const controller = new AbortController();
    const closed = new Error("original run closed");
    let current = true;
    const harness = await createBuildRecoveryHarness({
      refreshInPlace,
      afterReconcile: async () => {
        if (outcome === "cancelled") {
          controller.abort(closed);
        } else if (outcome === "superseded") {
          current = false;
        } else {
          if (refreshInPlace) {
            await harness.reclaim();
          }
          await worker.seedActivePlacement();
        }
      },
    });
    await expect(
      harness.execute(controller.signal, () => {
        if (!current) {
          throw closed;
        }
      }),
    ).rejects.toThrow(outcome === "replaced" ? STALE_WORKER_BUILD_REASON : closed.message);
    expectCalls(0, harness.redispatchPlacement, harness.launchTurn);
    expect(worker.placements.get(worker.SESSION_ID)).toMatchObject({
      state: refreshInPlace || outcome === "replaced" ? "active" : "reclaimed",
      turnClaim: null,
    });
  },
);

it.each([
  { refreshInPlace: false, rejection: "admission" },
  { refreshInPlace: true, rejection: "pending refresh" },
] as const)(
  "attempts build recovery only once after $rejection (refreshInPlace=$refreshInPlace)",
  async ({ refreshInPlace, rejection }) => {
    const harness = await createBuildRecoveryHarness({
      repeated: true,
      refreshInPlace,
      rejection,
    });
    await expect(harness.execute()).rejects.toThrow(
      rejection === "pending refresh"
        ? "Cloud worker runtime update is pending"
        : STALE_WORKER_BUILD_REASON,
    );
    expect(harness.redispatchPlacement).toHaveBeenCalledTimes(refreshInPlace ? 0 : 1);
    expect(harness.onAdmitted).toHaveBeenCalledOnce();
    expect(harness.launchTurn).not.toHaveBeenCalled();
    expect(worker.placements.get(worker.SESSION_ID)).toMatchObject({
      state: refreshInPlace ? "active" : "reclaimed",
      turnClaim: null,
    });
  },
);

it("does not retry a build error after worker handoff", async () => {
  const waitForAdmissionNode = vi.fn(async () => {});
  const harness = await createBuildRecoveryHarness({
    rejection: "handoff",
    waitForAdmissionNode,
  });
  await expect(harness.execute()).rejects.toThrow(STALE_WORKER_BUILD_REASON);
  expect(harness.redispatchPlacement).not.toHaveBeenCalled();
  expect(harness.launchTurn).toHaveBeenCalledOnce();
  expect(waitForAdmissionNode).not.toHaveBeenCalled();
  expect(worker.placements.get(worker.SESSION_ID)).toMatchObject({
    state: "failed",
    turnClaim: null,
  });
});

it("leaves a pending result fenced for its recovery owner instead of replacing the worker", async () => {
  const harness = await createBuildRecoveryHarness({ pendingResult: true });
  await expect(harness.execute()).rejects.toThrow(STALE_WORKER_BUILD_REASON);
  expectCalls(0, harness.redispatchPlacement, harness.launchTurn);
  expect(await worker.placements.listPendingWorkspaceResultsAsync()).toEqual([
    expect.objectContaining({
      sessionId: worker.SESSION_ID,
      recoveryRequestedAtMs: expect.any(Number),
    }),
  ]);
  expect(worker.placements.get(worker.SESSION_ID)).toMatchObject({
    state: "active",
    turnClaim: { claimId: harness.originalClaimIds[0] },
  });
  expect(harness.environments.destroy).not.toHaveBeenCalled();
});
