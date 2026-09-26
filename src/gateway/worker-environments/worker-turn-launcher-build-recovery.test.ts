import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunHandleActive,
} from "../../agents/embedded-agent-runner/runs.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { STALE_WORKER_BUILD_REASON, StaleWorkerBuildError } from "./admission.js";
import { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { WorkerRuntimeRefreshPendingError } from "./provider-runtime-refresh.js";
import {
  WorkerTunnelOwnerDisconnectedError,
  type WorkerTurnTunnelHandle,
} from "./tunnel-contract.js";
import {
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  credential,
  database,
  measureLaunchTurn,
  openSessionManager,
  placements,
  root,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
  type WorkerTurnLauncherOptions,
} from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { createWorkerWorkspaceRecoveryFixture } from "./workspace-recovery.test-support.js";

async function createBuildRecoveryHarness(
  options: {
    rejection?:
      | "recorded"
      | "admission"
      | "pending refresh"
      | "disconnected"
      | "launch"
      | "handoff";
    repeated?: boolean;
    pendingResult?: boolean;
    refreshInPlace?: boolean;
    withoutRecorder?: boolean;
    afterReconcile?: () => void | Promise<void>;
    waitForAdmissionNode?: WorkerTurnLauncherOptions["waitForAdmissionNode"];
    replyOperation?: ReturnType<typeof createReplyOperation>;
    duringRetryPreparation?: () => void;
  } = {},
) {
  await seedActivePlacement();
  const rejection = options.rejection ?? "admission";
  let environment = attachedEnvironment();
  const retire = () => {
    environment = {
      ...environment,
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      sharedHost: null,
      ownerEpoch: OWNER_EPOCH + 1,
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
    if (rejection === "launch" && (!replaced || options.repeated)) {
      throw new StaleWorkerBuildError();
    }
    request.onDispatchReady?.();
    if (rejection === "handoff") {
      throw new StaleWorkerBuildError();
    }
    const leafId = openSessionManager().appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "Continued on the replacement worker" }],
        timestamp: 51,
      }),
    );
    createWorkerSessionPlacementGate(placements).updateAckCursors({
      claim: request.turnClaim,
      transcriptSeq: 2,
      liveSeq: 1,
    });
    return {
      stdout: JSON.stringify({
        status: "completed",
        transcriptLeafId: leafId,
        transcriptNextSeq: (placements.get(SESSION_ID)?.lastTranscriptAckCursor ?? 0) + 1,
      }),
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    };
  });
  const destroy = vi.fn(async () => environment);
  const environments: WorkerTurnEnvironmentService &
    Parameters<typeof createWorkerPlacementDispatchService>[0]["environments"] = {
    ...unusedEnvironments(),
    prepareProjectIntent: async () => {
      throw new Error("unexpected prepared intent");
    },
    assertPreparedIntentCurrent: vi.fn(),
    getPreparedCandidates: () => [],
    schedulePreparedRefill: vi.fn(),
    bindPreparedWorkspace: async () => {
      throw new Error("unexpected prepared binding");
    },
    recordError: vi.fn(() => {
      throw new Error("unexpected provisioning interruption");
    }),
    supportsProviderExecutionMode: vi.fn(() => true),
    get: () => environment,
    acquireTurnCredential: async (claim) => {
      if (options.pendingResult) {
        placements.markWorkspaceResultPending(claim);
      }
      return credential();
    },
    acknowledgeCredentialDelivery: vi.fn(async () => true),
    startTunnel: async () => {
      if (rejection !== "handoff" && rejection !== "launch" && (!replaced || options.repeated)) {
        if (rejection === "disconnected") {
          throw new WorkerTunnelOwnerDisconnectedError(
            "device worker node is not connected with the supervisor dialect",
          );
        }
        if (rejection === "pending refresh") {
          throw new WorkerRuntimeRefreshPendingError("node was disconnected during startup");
        }
        throw new StaleWorkerBuildError();
      }
      return {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: async () => ({
          assertActive: async () => {},
          resume: async () => {},
        }),
        measureLaunchTurn,
        launchTurn,
        syncWorkspace: vi.fn(),
        reconcileWorkspace: async (request) => {
          if (request.source.kind !== "local") {
            throw new Error("expected a local workspace source");
          }
          request.source.journal.commit(MANIFEST_REF);
          return {
            manifestRef: MANIFEST_REF,
            changed: false,
            verifyStable: async () => {},
            verifyLocalStable: async () => {},
          };
        },
        stop: async () => {},
      };
    },
    stopTunnel: vi.fn(async () => {}),
    destroy,
    requestDestroy: destroy,
    attachSession: vi.fn(async () => {
      throw new Error("unexpected worker session attachment");
    }),
    createWithRequest: vi.fn(async () => {
      throw new Error("unexpected worker environment creation");
    }),
    reconcileOnce: async () => retire(),
    reconcileEnvironment: vi.fn(),
  };
  const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
  const dispatch = createWorkerPlacementDispatchService({
    placements,
    environments,
    runnerAvailability: { read: () => undefined, version: () => 0 },
    runLocalBarrier: async ({ startDispatch }) => startDispatch(),
    runRecoveryBarrier: async ({ run }) => await run({ kind: "local", path: root }),
    runActivationBarrier: async ({ activate }) => activate(),
    runMoveBarrier: async ({ begin }) => begin(),
    resolveMoveDestination: async () => undefined,
    runReclaimPreparation: async ({ run, authorize }) => await run(authorize),
    runReclaimBarrier: async ({ begin, reclaim }) =>
      await reclaim({ kind: "local", path: root }, begin()),
    runFailedReclaimBarrier: async ({ reclaim }) => await reclaim(),
    workspaceOperations,
    ...createWorkerWorkspaceRecoveryFixture({
      resolveWorkspace: async () => ({ kind: "local", path: root }),
    }),
  });
  const redispatchPlacement = vi.fn(async () => {
    replaced = true;
    environment = attachedEnvironment();
    await seedActivePlacement();
    const placement = placements.get(SESSION_ID);
    if (placement?.state !== "active") {
      throw new Error("replacement did not activate");
    }
    return placement;
  });
  let workspacePreparations = 0;
  const provider = createWorkerSessionTurnPlacementProvider({
    environments,
    placements,
    waitForAdmissionNode: async (params) => {
      await options.waitForAdmissionNode?.(params);
      if (rejection === "disconnected") {
        replaced = true;
      }
    },
    resolveWorkspace: async () => {
      if (++workspacePreparations === 2) {
        options.duringRetryPreparation?.();
      }
      return { kind: "local", path: root };
    },
    reconcileActivePlacement: async (environmentId) => {
      if (!options.pendingResult) {
        if (options.refreshInPlace) {
          createWorkerSessionPlacementGate(placements).assertWorkerRuntimeRefresh({
            sessionId: SESSION_ID,
            environmentId,
            ownerEpoch: OWNER_EPOCH,
          });
          const bundleHash = "b".repeat(64);
          environment = {
            ...environment,
            bootstrapReceipt: { ...environment.bootstrapReceipt!, bundleHash },
          };
          database.db
            .prepare(
              "UPDATE worker_session_placements SET worker_bundle_hash = ? WHERE session_id = ?",
            )
            .run(bundleHash, SESSION_ID);
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
  const input = turn(runId);
  const recorder = createUserTurnTranscriptRecorder({
    target: { ...sessionTarget, sessionEntry: undefined },
    input: { text: input.prompt },
  });
  const originalClaimIds: string[] = [];
  const onAdmitted = vi.fn(() => {
    const claim = placements.get(SESSION_ID)?.turnClaim;
    if (!claim) {
      throw new Error("admitted turn has no claim");
    }
    originalClaimIds.push(claim.claimId);
  });
  const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
  const onUserMessagePersisted = vi.fn();
  return {
    environments,
    launchTurn,
    redispatchPlacement,
    onAdmitted,
    originalClaimIds,
    runLocal,
    onUserMessagePersisted,
    reclaim: () =>
      dispatch.reclaim({ sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main" }),
    execute: (abortSignal?: AbortSignal, assertRunCurrent?: () => void) =>
      provider.executeTurn(
        { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId },
        {
          ...input,
          ...(options.replyOperation ? { replyOperation: options.replyOperation } : {}),
          ...(options.withoutRecorder ? {} : { userTurnTranscriptRecorder: recorder }),
          onUserMessagePersisted,
          ...(abortSignal ? { abortSignal } : {}),
        },
        runLocal,
        onAdmitted,
        assertRunCurrent,
      ),
  };
}

describe("worker turn launcher build recovery", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it("accepts Stop through the reply owner between refresh and retry preparation", async () => {
    const operation = createReplyOperation({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      resetTriggered: false,
    });
    operation.setPhase("running");
    const duringRetryPreparation = vi.fn(() => {
      expect(isEmbeddedAgentRunHandleActive(SESSION_ID)).toBe(false);
      expect(abortEmbeddedAgentRun(SESSION_ID)).toBe(true);
    });
    const harness = await createBuildRecoveryHarness({
      rejection: "pending refresh",
      refreshInPlace: true,
      replyOperation: operation,
      duringRetryPreparation,
    });
    try {
      await expect(harness.execute(operation.abortSignal)).rejects.toThrow();
      expect(duringRetryPreparation).toHaveBeenCalledOnce();
      expect(operation.abortSignal.aborted).toBe(true);
      expect(harness.launchTurn).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    } finally {
      operation.complete();
    }
  });

  it.each(
    (["pending refresh", "disconnected"] as const).flatMap((rejection) =>
      (["reconnected", "cancelled", "backend-cancelled", "superseded"] as const).map((outcome) => ({
        rejection,
        outcome,
      })),
    ),
  )(
    "retains the original submission through $rejection while availability is $outcome",
    async ({ rejection, outcome }) => {
      const reconnect = createDeferred();
      const waiting = createDeferred();
      const controller = new AbortController();
      let current = true;
      let nodeWaitSignal: AbortSignal | undefined;
      const waitForAdmissionNode = vi.fn<WorkerTurnLauncherOptions["waitForAdmissionNode"]>(
        async ({ signal, assertCurrent }) => {
          nodeWaitSignal = signal;
          assertCurrent();
          expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
          waiting.resolve();
          await racePromiseWithAbortSignal(reconnect.promise, signal);
          assertCurrent();
        },
      );
      const harness = await createBuildRecoveryHarness({
        rejection,
        refreshInPlace: true,
        waitForAdmissionNode,
      });
      const before = harness.environments.get(ENVIRONMENT_ID);
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
        await Promise.race([waiting.promise, execution]);
        expect(harness.launchTurn).not.toHaveBeenCalled();
        expect(waitForAdmissionNode).toHaveBeenCalledOnce();
        if (outcome === "cancelled") {
          controller.abort(new Error("original turn cancelled"));
          expect(nodeWaitSignal?.aborted).toBe(true);
        } else if (outcome === "backend-cancelled") {
          expect(abortEmbeddedAgentRun(SESSION_ID)).toBe(true);
          expect(nodeWaitSignal?.aborted).toBe(true);
        } else {
          current = outcome !== "superseded";
          reconnect.resolve();
        }
        const settled = await result;
        if (outcome === "reconnected") {
          expect(settled).toHaveProperty("value");
          expect(harness.launchTurn).toHaveBeenCalledOnce();
          expect(
            openSessionManager()
              .buildSessionContext()
              .messages.filter((message) => message.role === "user"),
          ).toHaveLength(1);
        } else {
          expect(settled).toHaveProperty("error");
          expect(harness.launchTurn).not.toHaveBeenCalled();
          expect(harness.environments.get(ENVIRONMENT_ID)).toEqual(before);
        }
        expect(harness.redispatchPlacement).not.toHaveBeenCalled();
        expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
      } finally {
        reconnect.resolve();
        await result;
      }
    },
  );

  it("bounds reconnect admission by the caller's timeout", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const waiting = createDeferred();
    const reconnect = createDeferred();
    const harness = await createBuildRecoveryHarness({
      rejection: "pending refresh",
      refreshInPlace: true,
      waitForAdmissionNode: async ({ signal }) => {
        waiting.resolve();
        await racePromiseWithAbortSignal(reconnect.promise, signal);
      },
    });
    const execution = harness.execute();
    const result = execution.catch((error: unknown) => error);
    try {
      await waiting.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await result).toBeInstanceOf(Error);
      expect(harness.launchTurn).not.toHaveBeenCalled();
      expect(harness.redispatchPlacement).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    } finally {
      reconnect.resolve();
      await result;
      vi.useRealTimers();
    }
  });

  it.each(
    [false, true].flatMap((refreshInPlace) =>
      [false, true].map((withoutRecorder) => ({ refreshInPlace, withoutRecorder })),
    ),
  )(
    "persists input once after pre-handoff rejection (refreshInPlace=$refreshInPlace, withoutRecorder=$withoutRecorder)",
    async ({ refreshInPlace, withoutRecorder }) => {
      const harness = await createBuildRecoveryHarness({
        rejection: "launch",
        withoutRecorder,
        refreshInPlace,
      });
      await harness.execute();
      expect(harness.launchTurn).toHaveBeenCalledTimes(2);
      expect(harness.onUserMessagePersisted).toHaveBeenCalledOnce();
      expect(
        openSessionManager()
          .buildSessionContext()
          .messages.filter((message) => message.role === "user"),
      ).toHaveLength(1);
      expect(harness.launchTurn.mock.calls[1]?.[0].plan.assignment.initialMessages).toEqual([]);
    },
  );

  it.each(["admission", "pending refresh"] as const)(
    "continues the submitted turn after %s by refreshing the same machine",
    async (rejection) => {
      const harness = await createBuildRecoveryHarness({ rejection, refreshInPlace: true });
      const before = placements.get(SESSION_ID);
      const result = await harness.execute();
      expect(result.payloads).toEqual([{ text: "Continued on the replacement worker" }]);
      expect(harness.redispatchPlacement).not.toHaveBeenCalled();
      expect(harness.launchTurn).toHaveBeenCalledOnce();
      expect(harness.onAdmitted).toHaveBeenCalledOnce();
      expect(harness.launchTurn.mock.calls[0]?.[0].turnClaim.claimId).not.toBe(
        harness.originalClaimIds[0],
      );
      expect(placements.get(SESSION_ID)).toMatchObject({
        state: "active",
        environmentId: before?.environmentId,
        activeOwnerEpoch: before?.activeOwnerEpoch,
        generation: before?.generation,
        workerBundleHash: "b".repeat(64),
        turnClaim: null,
      });
      expect(harness.environments.destroy).not.toHaveBeenCalled();
      expect(harness.runLocal).not.toHaveBeenCalled();
      expect(
        openSessionManager()
          .buildSessionContext()
          .messages.filter((message) => message.role === "user"),
      ).toHaveLength(1);
    },
  );

  it.each(["recorded", "admission"] as const)(
    "continues the same turn with a fresh claim after a %s build rejection",
    async (rejection) => {
      const harness = await createBuildRecoveryHarness({ rejection });
      const result = await harness.execute(new AbortController().signal);
      expect(result.payloads).toEqual([{ text: "Continued on the replacement worker" }]);
      expect(harness.redispatchPlacement).toHaveBeenCalledOnce();
      expect(harness.onAdmitted).toHaveBeenCalledOnce();
      expect(harness.launchTurn).toHaveBeenCalledOnce();
      expect(harness.launchTurn.mock.calls[0]?.[0].turnClaim.claimId).not.toBe(
        harness.originalClaimIds[0],
      );
      expect(harness.runLocal).not.toHaveBeenCalled();
      expect(
        openSessionManager()
          .buildSessionContext()
          .messages.filter((message) => message.role === "user"),
      ).toHaveLength(1);
      expect(placements.get(SESSION_ID)).toMatchObject({
        state: "active",
        turnClaim: null,
        terminalReason: null,
        recoveryError: null,
      });
    },
  );

  it.each(
    (["cancelled", "superseded", "replaced"] as const).flatMap((outcome) =>
      [false, true].map((refreshInPlace) => ({ outcome, refreshInPlace })),
    ),
  )(
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
            await seedActivePlacement();
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
      expect(harness.redispatchPlacement).not.toHaveBeenCalled();
      expect(harness.launchTurn).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)).toMatchObject({
        state: refreshInPlace || outcome === "replaced" ? "active" : "reclaimed",
        turnClaim: null,
      });
    },
  );

  it.each([
    { refreshInPlace: false, rejection: "admission" },
    { refreshInPlace: true, rejection: "admission" },
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
      expect(placements.get(SESSION_ID)).toMatchObject({
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
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "failed", turnClaim: null });
  });

  it("leaves a pending result fenced for its recovery owner instead of replacing the worker", async () => {
    const harness = await createBuildRecoveryHarness({ pendingResult: true });
    await expect(harness.execute()).rejects.toThrow(STALE_WORKER_BUILD_REASON);
    expect(harness.redispatchPlacement).not.toHaveBeenCalled();
    expect(harness.launchTurn).not.toHaveBeenCalled();
    expect(placements.listPendingWorkspaceResults()).toEqual([
      expect.objectContaining({ sessionId: SESSION_ID, recoveryRequestedAtMs: expect.any(Number) }),
    ]);
    expect(placements.get(SESSION_ID)).toMatchObject({
      state: "active",
      turnClaim: { claimId: harness.originalClaimIds[0] },
    });
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });
});
