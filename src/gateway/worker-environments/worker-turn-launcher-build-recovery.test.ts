import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { STALE_WORKER_BUILD_REASON, StaleWorkerBuildError } from "./admission.js";
import { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
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
} from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

function createBuildRecoveryHarness(
  options: {
    rejection?: "recorded" | "admission" | "launch" | "handoff";
    repeated?: boolean;
    pendingResult?: boolean;
    refreshInPlace?: boolean;
    withoutRecorder?: boolean;
    afterReconcile?: () => void | Promise<void>;
  } = {},
) {
  seedActivePlacement();
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
    acknowledgeCredentialDelivery: vi.fn(() => true),
    startTunnel: async () => {
      if (rejection !== "handoff" && rejection !== "launch" && (!replaced || options.repeated)) {
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
    create: vi.fn(async () => {
      throw new Error("unexpected worker environment creation");
    }),
    createFromProfileSnapshot: vi.fn(async () => {
      throw new Error("unexpected inherited worker environment creation");
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
    resolveWorkspace: async () => ({ kind: "local", path: root }),
    reportWorkspaceResultConflict: async () => {},
    resolveWorkspaceResultConflict: async () => ({ kind: "absent" }),
  });
  const redispatchReclaimed = vi.fn(async () => {
    replaced = true;
    environment = attachedEnvironment();
    seedActivePlacement();
    const placement = placements.get(SESSION_ID);
    if (placement?.state !== "active") {
      throw new Error("replacement did not activate");
    }
    return placement;
  });
  const provider = createWorkerSessionTurnPlacementProvider({
    environments,
    placements,
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
    redispatchReclaimed,
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
    redispatchReclaimed,
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

  it.each([false, true])(
    "persists fallback input once after pre-handoff rejection (refreshInPlace=%s)",
    async (refreshInPlace) => {
      const harness = createBuildRecoveryHarness({
        rejection: "launch",
        withoutRecorder: true,
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

  it("continues the submitted turn after refreshing the same machine", async () => {
    const harness = createBuildRecoveryHarness({ refreshInPlace: true });
    const before = placements.get(SESSION_ID);
    const result = await harness.execute();
    expect(result.payloads).toEqual([{ text: "Continued on the replacement worker" }]);
    expect(harness.redispatchReclaimed).not.toHaveBeenCalled();
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
  });

  it.each(["recorded", "admission"] as const)(
    "continues the same turn with a fresh claim after a %s build rejection",
    async (rejection) => {
      const harness = createBuildRecoveryHarness({ rejection });
      const result = await harness.execute(new AbortController().signal);
      expect(result.payloads).toEqual([{ text: "Continued on the replacement worker" }]);
      expect(harness.redispatchReclaimed).toHaveBeenCalledOnce();
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
      const harness = createBuildRecoveryHarness({
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
            seedActivePlacement();
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
      expect(harness.redispatchReclaimed).not.toHaveBeenCalled();
      expect(harness.launchTurn).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)).toMatchObject({
        state: refreshInPlace || outcome === "replaced" ? "active" : "reclaimed",
        turnClaim: null,
      });
    },
  );

  it.each([false, true])(
    "attempts build recovery only once (refreshInPlace=%s)",
    async (refreshInPlace) => {
      const harness = createBuildRecoveryHarness({ repeated: true, refreshInPlace });
      await expect(harness.execute()).rejects.toThrow(STALE_WORKER_BUILD_REASON);
      expect(harness.redispatchReclaimed).toHaveBeenCalledTimes(refreshInPlace ? 0 : 1);
      expect(harness.onAdmitted).toHaveBeenCalledOnce();
      expect(harness.launchTurn).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)).toMatchObject({
        state: refreshInPlace ? "active" : "reclaimed",
        turnClaim: null,
      });
    },
  );

  it("does not retry a build error after worker handoff", async () => {
    const harness = createBuildRecoveryHarness({ rejection: "handoff" });
    await expect(harness.execute()).rejects.toThrow(STALE_WORKER_BUILD_REASON);
    expect(harness.redispatchReclaimed).not.toHaveBeenCalled();
    expect(harness.launchTurn).toHaveBeenCalledOnce();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "failed", turnClaim: null });
  });

  it("leaves a pending result fenced for its recovery owner instead of replacing the worker", async () => {
    const harness = createBuildRecoveryHarness({ pendingResult: true });
    await expect(harness.execute()).rejects.toThrow(STALE_WORKER_BUILD_REASON);
    expect(harness.redispatchReclaimed).not.toHaveBeenCalled();
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
