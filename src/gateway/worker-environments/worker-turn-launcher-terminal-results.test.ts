import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerLiveEventParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent-runner/run.js";
import { resolveModelFallbackError } from "../../agents/failover-error.js";
import {
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
} from "../../agents/media-generation-activity.js";
import { runWithModelFallback } from "../../agents/model-fallback-runner.js";
import { installSessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import type { SpawnResult } from "../../process/exec.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { waitForSessionRunEnd } from "../../sessions/session-controller.native-runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { NodeWorkerWorkspaceTransferError } from "../../worker/node-workspace-transfer-protocol.js";
import { createGatewayWorkerDispatchAdmission } from "../server-worker-placement-dispatch-admission.js";
import { createGatewayWorkerPlacementMoveBarrier } from "../server-worker-placement-move-barrier.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "../server-worker-placement-reclaim.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "../session-utils-store.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { hashWorkerCredential } from "./credential.js";
import { createWorkerInferenceStore } from "./inference-store.js";
import { createWorkerLiveEventReceiver } from "./live-events.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import {
  ACTIVE_PLACEMENT,
  LOCAL_PLACEMENT,
  REQUEST,
  createCoordinatorTestService,
} from "./placement-dispatch-coordinator.test-support.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerPlacementMoveService } from "./placement-move-service.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { createWorkerEnvironmentService } from "./service.js";
import * as support from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import { success } from "./tunnel.test-support.js";
import {
  WorkerTurnExecutionError,
  WorkerWorkspaceReconciliationError,
} from "./worker-turn-failure.js";
import {
  completedWorkerMessage,
  environmentForTunnel,
  localResult,
  runIdentity,
} from "./worker-turn-launcher-flow.test-support.js";
import * as fx from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { gitInit } from "./workspace-recovery.test-support.js";

afterAll(closeStateDatabaseForTest);

function recoveringWorker(options: { beforeAck?: () => Promise<unknown>; retry?: boolean } = {}) {
  const entered = createDeferredCore();
  const released = createDeferredCore();
  const error = new NodeWorkerWorkspaceTransferError(
    "workspace-transfer-failed: gateway TLS fingerprint mismatch",
  );
  const fail = async () => {
    entered.resolve();
    await released.promise;
    throw error;
  };
  const tunnel = fx.createWorkerTurnTunnel({
    launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
      request.onDispatchReady?.();
      if (options.beforeAck) {
        await options.beforeAck();
      }
      const completed = await fx.openSessionManager();
      const leafId = await completed.appendMessageAsync(completedWorkerMessage());
      return fx.acknowledgeCompletedWorkerTurn(request.turnClaim, leafId);
    }),
    reconcileWorkspace: vi
      .fn(options.retry ? fx.reconcileUnchangedLocalWorkspace : fail)
      .mockImplementationOnce(fx.reconcileUnchangedLocalWorkspace)
      .mockImplementationOnce(fail),
  });
  const destroy = vi.fn(async () => fx.attachedEnvironment());
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    error,
    tunnel,
    destroy,
    environments: fx.workerTurnEnvironments(tunnel, {
      acknowledgeCredentialDelivery: vi.fn(async () => true),
      destroy,
    }),
  };
}

describe("worker finishing admission", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("revalidates a credential replaced during live publication before terminal ACK", async () => {
    const { apply, liveEvents } = support.sequencedLiveEvents();
    const { identity, placementStore, workerService } = await support.placementHarness(
      "worker-live-reentrant-credential",
      "session-live-reentrant-credential",
      { liveEvents },
    );
    apply.mockImplementationOnce(async () => {
      await support.testState.store.renewCredential({
        environmentId: identity.environmentId,
        expectedOwnerEpoch: identity.ownerEpoch,
        sessionId: identity.sessionId,
        rpcSetVersion: identity.rpcSetVersion,
        expiresAtMs: identity.credentialExpiresAtMs,
        credentialHash: hashWorkerCredential("replacement-credential", identity.turnClaim!),
      });
      return { ok: true, result: { ackedSeq: 1 } };
    });
    await expect(
      workerService.pushLiveEvent(identity, support.terminalEvent(identity)),
    ).resolves.toEqual({ ok: false, closeReason: "credential-replaced" });
    expect(placementStore.updateAckCursors).not.toHaveBeenCalled();
  });
});

describe("worker turn launcher terminal results", () => {
  beforeEach(fx.setupWorkerTurnLauncherTest);
  afterEach(() => fx.cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));

  it.each<{
    stopReason: "stop" | "error";
    reconciliationFails: boolean;
    cleanupFailure?: string;
    providerFailure?: true;
  }>([
    { stopReason: "stop", reconciliationFails: false },
    { stopReason: "error", reconciliationFails: true },
    { stopReason: "error", reconciliationFails: false, providerFailure: true },
    {
      stopReason: "stop",
      reconciliationFails: false,
      cleanupFailure: "Browser cleanup failed: rate limit exceeded",
    },
  ])(
    "retains the ACKed finishing outcome after assistant $stopReason (reconciliation fails: $reconciliationFails; cleanup: $cleanupFailure; provider fallback: $providerFailure)",
    async ({ stopReason, reconciliationFails, cleanupFailure, providerFailure }) => {
      const outerFallback = cleanupFailure !== undefined || providerFailure === true;
      await fx.seedActivePlacement();
      const grant = fx.credential();
      const environment = fx.attachedEnvironment();
      const gate = createWorkerSessionPlacementGate(fx.placements);
      const service = createWorkerEnvironmentService({
        scheduler: createTestGatewayScheduler(),
        store: {
          ...(await createWorkerEnvironmentStore({ database: fx.database })),
          get: () => environment,
          getCredential: () => ({
            environmentId: fx.ENVIRONMENT_ID,
            credentialHash: grant.deliveryId,
            bundleHash: grant.bundleHash,
            sessionId: fx.SESSION_ID,
            rpcSetVersion: grant.rpcSetVersion,
            ownerEpoch: fx.OWNER_EPOCH,
            expiresAtMs: grant.expiresAtMs,
            deliveredAtMs: Date.now(),
          }),
        },
        getConfig: () => ({ session: { store: fx.sessionTarget.storePath } }),
        resolveProvider: () => undefined,
        prepareInstallation: vi.fn(),
        bootstrapWorker: vi.fn(),
        inferenceStore: createWorkerInferenceStore({ path: fx.database.path }),
        placementStore: gate,
        liveEvents: createWorkerLiveEventReceiver(),
      });
      const failure =
        cleanupFailure ??
        (providerFailure
          ? "provider rate limit exceeded"
          : "turn failed | provider failed | computer cleanup failed | native close failed");
      const effectFile = path.join(fx.root, "worker-effects.txt");
      const launchedModels: string[] = [];
      const reconciliationError = new NodeWorkerWorkspaceTransferError("workspace transfer failed");
      const runId = "run-finishing-cleanup";
      // Real dispatch supplies the session-bound outer context before worker admission.
      const dispatchClaim = claimAgentRunContext(
        runId,
        {
          sessionId: fx.SESSION_ID,
          sessionKey: fx.SESSION_KEY,
          agentId: "main",
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
        },
        { ownsContext: true, trackOwner: true },
      );
      assert(dispatchClaim, "expected dispatch run context");
      const workerTurn = fx.turn(runId);
      let identity: WorkerConnectionIdentity;
      const lifecycle = (
        seq: number,
        payload: Extract<WorkerLiveEventParams["event"], { kind: "lifecycle" }>["payload"],
        lastAckedSeq = 0,
      ): WorkerLiveEventParams => ({
        runEpoch: fx.OWNER_EPOCH,
        runId,
        seq,
        lastAckedSeq,
        event: { kind: "lifecycle", payload },
      });
      const expectAck = (event: WorkerLiveEventParams, ackedSeq: number) =>
        expect(service.pushLiveEvent(identity, event)).resolves.toEqual({
          ok: true,
          result: { ackedSeq },
        });
      const tunnel = fx.createWorkerTurnTunnel({
        launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
          request.onDispatchReady?.();
          launchedModels.push(request.plan.assignment.modelRef.model);
          if (!providerFailure) {
            await fs.appendFile(effectFile, "effect\n");
          }
          if (launchedModels.length > 1) {
            // The second launch is the assertion boundary; do not replay its live-event stream.
            throw new WorkerTurnExecutionError("Unexpected second worker execution");
          }
          const leafId = await (
            await fx.openSessionManager()
          ).appendMessageAsync(
            makeAgentAssistantMessage({
              content: providerFailure ? [] : [{ type: "text", text: "Remote answer" }],
              stopReason,
              ...(stopReason === "error" ? { errorMessage: "provider failed" } : {}),
              timestamp: 21,
            }),
          );
          await gate.updateAckCursors({ claim: request.turnClaim, transcriptSeq: 2 });
          identity = {
            environmentId: fx.ENVIRONMENT_ID,
            credentialHash: grant.deliveryId,
            bundleHash: grant.bundleHash,
            sessionId: fx.SESSION_ID,
            runId,
            turnClaim: request.turnClaim,
            ownerEpoch: fx.OWNER_EPOCH,
            rpcSetVersion: grant.rpcSetVersion,
            protocolFeatures: environment.bootstrapReceipt!.protocolFeatures,
            credentialExpiresAtMs: grant.expiresAtMs,
          };
          const finishPayload = {
            phase: "finishing" as const,
            endedAt: 2,
            stopReason: "error" as const,
            error: failure,
            ...(cleanupFailure ? { replayInvalid: true as const } : {}),
          };
          const finishing = lifecycle(2, finishPayload);
          await expectAck(finishing, 0);
          expect(await fx.placements.listPendingWorkspaceResultsAsync()).toHaveLength(0);
          await expectAck(
            lifecycle(2, {
              ...finishPayload,
              error: "duplicate must not replace original",
              replayInvalid: undefined,
            }),
            0,
          );
          await expectAck(lifecycle(1, { phase: "start", startedAt: 1 }), 2);
          expect(await fx.placements.listPendingWorkspaceResultsAsync()).toHaveLength(1);
          return success(
            JSON.stringify({
              status: "failed",
              reason: "turn-failed",
              transcriptLeafId: leafId,
              transcriptNextSeq: 3,
            }),
          );
        }),
        reconcileWorkspace: vi
          .fn(async (request) => {
            if (reconciliationFails) {
              throw reconciliationError;
            }
            return fx.reconcileUnchangedLocalWorkspace(request);
          })
          .mockImplementationOnce(fx.reconcileUnchangedLocalWorkspace),
      }) satisfies WorkerTunnelHandle;
      const environments = fx.workerTurnEnvironments(tunnel, {
        get: vi.fn(() => environment),
        acquireTurnCredential: vi.fn(async (claim) => {
          grant.turnClaim = claim;
          grant.deliveryId = hashWorkerCredential(grant.credential, claim);
          return grant;
        }),
        acknowledgeCredentialDelivery: vi.fn(async () => true),
        destroy: vi.fn(async () => environment),
      });
      const reconcileActivePlacement = vi.fn(async () => {
        const [pending] = await fx.placements.listPendingWorkspaceResultsAsync();
        assert(pending, "expected pending workspace result");
        expect(pending).toMatchObject({ sessionId: fx.SESSION_ID, runId });
        await fx.placements.failWorkspaceResultAndReleaseTurn(pending, reconciliationError);
      });
      const provider = fx.createWorkerSessionTurnPlacementProvider({
        environments,
        placements: fx.placements,
        reconcileActivePlacement,
      });
      const uninstall = installSessionPlacementAdmissionProvider(provider);
      try {
        const runLocal = vi.fn(localResult);
        const execute = () => provider.executeTurn(runIdentity(runId), workerTurn, runLocal);
        const config = {
          ...workerTurn.config,
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } },
                "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
              },
            },
          },
        };
        let mediaTasks = getGeneratedMediaTaskIdsForSessionKey(fx.SESSION_KEY);
        const candidateFailures: unknown[] = [];
        const runCandidate = (candidateProvider: string, model: string) => {
          mediaTasks = getGeneratedMediaTaskIdsForSessionKey(fx.SESSION_KEY);
          return runEmbeddedAgent({
            ...workerTurn,
            config,
            provider: candidateProvider,
            model,
            suppressNextUserMessagePersistence: launchedModels.length > 0,
          }).catch((error: unknown) => {
            candidateFailures.push(error);
            throw error;
          });
        };
        const runOuterEntry = () =>
          runEmbeddedAgentEntry({
            selection: {
              cfg: config,
              provider: "openai",
              model: "gpt-5.6-luna",
              manifestPlugins: [],
              fallbacksOverride: ["openai/gpt-5.6-sol"],
            },
            identity: runIdentity(runId),
            harness: {
              workspaceDir: fx.root,
              sessionKey: fx.SESSION_KEY,
              preparation: { kind: "direct" },
              resolveRuntimeOverride: () => "openclaw",
            },
            // Use the command/RPC producer, not a test veto derived from the answer.
            behavior: {
              kind: "command-rpc",
              hasCommittedSideEffect: () =>
                hasNewGeneratedMediaTaskForSessionKey(fx.SESSION_KEY, mediaTasks),
            },
            sessionOverride: { kind: "preserve" },
            runCandidate,
          });
        const observed = await (
          outerFallback
            ? runOuterEntry()
            : reconciliationFails
              ? runWithModelFallback({
                  cfg: undefined,
                  provider: "fixture-provider",
                  model: "fixture-model",
                  manifestPlugins: [],
                  fallbacksOverride: ["fixture-next/fixture-model"],
                  run: execute,
                })
              : execute()
        ).catch((error: unknown) => error);
        const expectSettled = async () => {
          expect(fx.placements.get(fx.SESSION_ID)).toMatchObject({
            state: reconciliationFails ? "failed" : "active",
            turnClaim: null,
          });
          expect(await fx.placements.listPendingWorkspaceResultsAsync()).toHaveLength(0);
          expect(environments.destroy).not.toHaveBeenCalled();
        };
        if (outerFallback) {
          expect(candidateFailures[0]).toBeInstanceOf(WorkerTurnExecutionError);
          expect(candidateFailures[0]).toMatchObject({ message: failure });
          expect(tunnel.reconcileWorkspace).toHaveBeenCalledTimes(providerFailure ? 3 : 2);
          expect((await fx.openSessionManager()).getLeafEntry()).toMatchObject({
            type: "message",
            message: {
              role: "assistant",
              stopReason,
              content: providerFailure ? [] : [{ type: "text", text: "Remote answer" }],
            },
          });
          await expectSettled();
          if (providerFailure) {
            expect(launchedModels).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
            expect(observed).toMatchObject({ message: "Unexpected second worker execution" });
            await expect(fs.stat(effectFile)).rejects.toMatchObject({ code: "ENOENT" });
            return;
          }
          expect
            .soft(launchedModels, "cleanup must not replay the committed worker effect")
            .toEqual(["gpt-5.6-luna"]);
          expect.soft(await fs.readFile(effectFile, "utf8")).toBe("effect\n");
          expect.soft(observed).toBe(candidateFailures[0]);
          return;
        }
        expect(observed).toMatchObject({ message: expect.stringContaining(failure) });
        if (reconciliationFails) {
          expect(observed).toMatchObject({ cause: { cause: reconciliationError } });
          expect(observed).toMatchObject({ cause: expect.any(WorkerWorkspaceReconciliationError) });
          expect(resolveModelFallbackError(observed)).toEqual({
            kind: "coordination",
            error: observed,
          });
          expect(reconcileActivePlacement).toHaveBeenCalledExactlyOnceWith(fx.ENVIRONMENT_ID);
        } else {
          expect(observed).toMatchObject({ message: failure });
          expect(reconcileActivePlacement).not.toHaveBeenCalled();
        }
        expect(launchedModels).toHaveLength(1);
        expect(runLocal).not.toHaveBeenCalled();
        await expectSettled();
        await expect(
          service.pushLiveEvent(
            identity!,
            lifecycle(2, { phase: "finishing", endedAt: 3, error: "late" }, 2),
          ),
        ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
      } finally {
        uninstall();
        await service.stop();
        workerTurn.preparedRunAdmission.close();
        releaseAgentRunContext(runId, dispatchClaim);
      }
    },
  );

  it("settles targeted result recovery while same-session Stop waits for its turn claim", async () => {
    await fx.seedActivePlacement();
    const worker = recoveringWorker();
    const stopController = new AbortController();
    const claimWaitCleanup = new AbortController();
    const stopStarted = createDeferredCore();
    const targetedAdmission = createDeferredCore();
    const targetRecovery = vi.fn(async () => {
      const [pending] = await fx.placements.listPendingWorkspaceResultsAsync();
      assert(pending, "expected pending workspace result");
      await fx.placements.failWorkspaceResultAndReleaseTurn(pending, worker.error);
    });
    const stopCleanup = vi.fn(async () => ({
      ...LOCAL_PLACEMENT,
      sessionId: fx.SESSION_ID,
      sessionKey: fx.SESSION_KEY,
    }));
    const waitForClaim = fx.placements.waitForTurnClaimRelease;
    vi.spyOn(fx.placements, "waitForTurnClaimRelease").mockImplementation((sessionId, options) => {
      return waitForClaim(sessionId, { ...options, signal: claimWaitCleanup.signal });
    });
    const barriers = createGatewayWorkerPlacementReclaimBarriers({
      placements: fx.placements,
      loadSessionRuntime: async () => ({
        managedWorktrees: { findLiveByOwner: async () => undefined },
        resolveGatewaySessionStoreTargetInWorker: (params) =>
          resolveGatewaySessionStoreTargetInWorker({
            ...params,
            cfg: {
              ...params.cfg,
              session: { ...params.cfg.session, store: fx.sessionTarget.storePath },
            },
          }),
        resolveCanonicalSessionEntryFromStoreKeys,
      }),
      cancelSessionWork: async ({ assertCurrent }) => {
        assertCurrent();
        stopController.abort(new Error("Stop requested"));
        stopStarted.resolve();
      },
      revokeSessionAuthority: () => {},
    });
    const dispatch = coordinateWorkerPlacementDispatch(
      createCoordinatorTestService({
        dispatch: async (request) => ({ ...ACTIVE_PLACEMENT, ...request }),
        reclaim: async (request, authorize, beforeDrain, serialize, pendingOperations) =>
          barriers.runReclaimPreparation({
            ...request,
            authorize,
            beforeDrain,
            pendingOperations,
            run: async () => serialize!(stopCleanup),
          }),
        reconcileActive: async (_environmentId, admit) => {
          const pending = admit ? admit([fx.SESSION_ID], targetRecovery) : targetRecovery();
          targetedAdmission.resolve();
          await pending;
        },
      }),
      (_request, run) => run(),
    );
    const reconcileActivePlacement = vi.fn(dispatch.reconcileActive);
    const provider = fx.createWorkerSessionTurnPlacementProvider({
      environments: worker.environments,
      placements: fx.placements,
      reconcileActivePlacement,
    });

    const workerTurn = {
      ...fx.turn("run-reconcile-tunnel-loss"),
      abortSignal: stopController.signal,
    };
    const running = provider
      .executeTurn(runIdentity(workerTurn.runId), workerTurn, localResult)
      .catch((error: unknown) => error);
    await worker.entered;
    const stopping = dispatch
      .reclaim({ sessionId: fx.SESSION_ID, sessionKey: fx.SESSION_KEY, agentId: "main" })
      .catch((error: unknown) => error);
    try {
      await stopStarted.promise;
      expect(fx.placements.get(fx.SESSION_ID)?.turnClaim).not.toBeNull();
      worker.release();
      await targetedAdmission.promise;
      // An unrelated completed dispatch gives admitted recovery a deterministic progress
      // boundary; a Stop that reserved this session too early leaves recovery unentered.
      await dispatch.dispatch({ ...REQUEST, sessionId: "unrelated" });
      expect(targetRecovery).toHaveBeenCalledOnce();
      await expect(running).resolves.toMatchObject({
        payloads: [{ text: "Remote work completed" }],
      });
      await expect(stopping).resolves.toMatchObject({ state: "local", sessionId: fx.SESSION_ID });
      expect(stopCleanup).toHaveBeenCalledOnce();
    } finally {
      worker.release();
      // Failure cleanup aborts only the waiter; recovery remains the sole claim-release owner.
      claimWaitCleanup.abort();
      await Promise.all([running, stopping]);
      await waitForSessionRunEnd(fx.SESSION_ID, null);
      workerTurn.preparedRunAdmission.close();
    }

    expect(reconcileActivePlacement).toHaveBeenCalledWith(fx.ENVIRONMENT_ID);
    expect(fx.placements.get(fx.SESSION_ID)).toMatchObject({ state: "failed", turnClaim: null });
    expect(await fx.placements.listPendingWorkspaceResultsAsync()).toHaveLength(0);
    expect(worker.destroy).not.toHaveBeenCalled();
  });

  it("recovers a durable Move result after its caller receives the final reply", async () => {
    await fx.seedActivePlacement();
    await gitInit(fx.root);
    const source = fx.placements.get(fx.SESSION_ID);
    assert(source?.state === "active", "Expected active source");
    const request = {
      sessionId: fx.SESSION_ID,
      sessionKey: fx.SESSION_KEY,
      agentId: "main",
      source: {
        generation: source.generation,
        environmentId: source.environmentId,
        ownerEpoch: source.activeOwnerEpoch,
      },
      target: { kind: "gateway" as const },
    };
    // The exact retry joins the prior Move intent while the worker retains its original claim.
    const worker = recoveringWorker({
      retry: true,
      beforeAck: () => fx.placements.beginPlacementMove(request),
    });
    const claimWaitCleanup = new AbortController();
    const barrierEntered = createDeferredCore();
    const startBarrier = createDeferredCore();
    const claimWaitEntered = createDeferredCore();
    const interruptionEntered = createDeferredCore();
    const targetedAdmission = createDeferredCore();
    const recoverySettled = createDeferredCore();
    const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
    const completeResult = vi.spyOn(fx.placements, "completeWorkspaceResultAndReleaseTurn");
    const recoveryEntered = vi.fn((_mode?: "results-only") => {});
    const harness = await createHarness(fx.database, fx.placements, {
      workspacePath: fx.root,
      workspaceOperations,
    });
    vi.mocked(harness.environments.get).mockReturnValue(fx.attachedEnvironment());
    const reconcileActive = harness.service.reconcileActive;
    vi.spyOn(harness.service, "reconcileActive").mockImplementation(
      (environmentId, admitRecovery) =>
        reconcileActive(environmentId, (sessionIds, run) => {
          const pending = admitRecovery!(sessionIds, (mode) => {
            recoveryEntered(mode);
            return run(mode).finally(() => recoverySettled.resolve());
          });
          targetedAdmission.resolve();
          return pending;
        }),
    );
    const waitForClaim = fx.placements.waitForTurnClaimRelease;
    vi.spyOn(fx.placements, "waitForTurnClaimRelease").mockImplementation((sessionId, options) => {
      const pending = waitForClaim(sessionId, {
        ...options,
        signal: options.signal
          ? AbortSignal.any([options.signal, claimWaitCleanup.signal])
          : claimWaitCleanup.signal,
      });
      claimWaitEntered.resolve();
      return pending;
    });
    const unexpected = async (): Promise<never> => {
      throw new Error("Unexpected destination or abandoned-source work");
    };
    const reclaimSource = vi.fn(async (): Promise<never> => {
      expect(fx.placements.get(fx.SESSION_ID)).toMatchObject({
        state: "draining",
        turnClaim: null,
      });
      throw new Error("fixture: Move barrier complete");
    });
    const loadSessionRuntime = await fx.createWorkerTurnSessionRuntimeLoader();
    const moveBarrier = createGatewayWorkerPlacementMoveBarrier({
      placements: fx.placements,
      loadSessionRuntime,
      revokeSessionAuthority: () => interruptionEntered.resolve(),
    });
    const moveService = createWorkerPlacementMoveService({
      placements: fx.placements,
      environments: { get: () => fx.attachedEnvironment() },
      runMoveBarrier: async (params) => {
        barrierEntered.resolve();
        await startBarrier.promise;
        return moveBarrier(params);
      },
      dispatch: unexpected,
      reclaimSource,
      validateAbandonSource: () => {
        throw new Error("Unexpected abandonment");
      },
      abandonSource: unexpected,
      resolveDestination: unexpected,
    });
    const admit = createGatewayWorkerDispatchAdmission(loadSessionRuntime);
    const dispatch = coordinateWorkerPlacementDispatch(
      {
        ...harness.service,
        forceDestroyEnvironment: async () => fx.attachedEnvironment(),
        getEnvironmentAttachedSessionIds: () => ["unrelated"],
        readEnvironmentSessionIds: async () => ["unrelated"],
        move: moveService.move,
      },
      admit,
    );
    vi.mocked(harness.environments.startTunnel).mockResolvedValue(worker.tunnel);
    const reconcileActivePlacement = vi.fn(dispatch.reconcileActive);
    const provider = fx.createWorkerSessionTurnPlacementProvider({
      environments: worker.environments,
      placements: fx.placements,
      reconcileActivePlacement,
      workspaceOperations,
    });

    const workerTurn = fx.turn("run-reconcile-tunnel-loss");
    let admittedOperation: ReplyOperation | undefined;
    const running = withSessionTurn(
      {
        sessionKey: fx.SESSION_KEY,
        sessionId: fx.SESSION_ID,
        storePath: fx.sessionTarget.storePath,
      },
      async (operation, signal) => {
        assert(operation, "Expected the worker's admitted controller operation");
        admittedOperation = operation;
        return await provider.executeTurn(
          runIdentity(workerTurn.runId),
          { ...workerTurn, replyOperation: operation, abortSignal: signal },
          localResult,
        );
      },
    ).catch((error: unknown) => error);
    await worker.entered;
    await expect(running).resolves.toMatchObject({
      payloads: [{ text: "Remote work completed" }],
    });
    expect(fx.placements.get(fx.SESSION_ID)?.state).toBe("draining");
    expect(await fx.placements.listPendingWorkspaceResultsAsync()).toHaveLength(1);
    const moving = dispatch.move(request).catch((error: unknown) => error);
    try {
      await barrierEntered.promise;
      startBarrier.resolve();
      await awaitGateBeforeSettlement(
        interruptionEntered.promise,
        moving,
        "Move settled before entering controller interruption",
      );
      expect(admittedOperation?.abortSignal.aborted).toBe(false);
      worker.release();
      await targetedAdmission.promise;
      await dispatch.forceDestroyEnvironment("unrelated");
      expect(recoveryEntered).toHaveBeenCalledExactlyOnceWith("results-only");
      await recoverySettled.promise;
      await awaitGateBeforeSettlement(
        claimWaitEntered.promise,
        moving,
        "Move settled before reaching the durable turn-claim wait",
      );
      expect(completeResult).toHaveBeenCalledOnce();
      expect(fx.placements.get(fx.SESSION_ID)?.turnClaim).toBeNull();
      await expect(moving).resolves.toMatchObject({
        message: "fixture: Move barrier complete",
      });
      expect(reclaimSource).toHaveBeenCalledOnce();
    } finally {
      worker.release();
      startBarrier.resolve();
      // Failure cleanup aborts only the waiter; recovery remains the sole claim-release owner.
      claimWaitCleanup.abort();
      await Promise.all([running, moving]);
      await waitForSessionRunEnd(fx.SESSION_ID, null);
      workerTurn.preparedRunAdmission.close();
    }

    expect(reconcileActivePlacement).toHaveBeenCalledWith(fx.ENVIRONMENT_ID);
    expect(fx.placements.get(fx.SESSION_ID)).toMatchObject({ state: "draining", turnClaim: null });
    expect(await fx.placements.listPendingWorkspaceResultsAsync()).toHaveLength(0);
    expect(worker.tunnel.reconcileWorkspace).toHaveBeenCalledTimes(3);
    expect(harness.environments.startTunnel).toHaveBeenCalledOnce();
    expect(harness.reportWorkspaceResultRecoveryFailure).not.toHaveBeenCalled();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(worker.destroy).not.toHaveBeenCalled();
  });

  it.each(fx.workerTurnTerminalReplyCases)(
    "reports canonical usage, prompt tools, and $name",
    async ({
      content,
      visibleText,
      rawText,
      terminalReply = { disposition: "empty" },
      costs = { first: 0, last: 0, total: 0 },
    }) => {
      await fx.seedActivePlacement();
      const environments = environmentForTunnel({
        startTunnel: vi.fn(async () =>
          fx.createWorkerTurnTunnel({
            launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
              request.onDispatchReady?.();
              const completed = await fx.openSessionManager();
              await completed.appendMessageAsync(
                makeAgentAssistantMessage({
                  content: [{ type: "toolCall", id: "call-usage", name: "read", arguments: {} }],
                  model: "gpt-first-call",
                  stopReason: "toolUse",
                  timestamp: 21,
                  usage: {
                    input: 100,
                    output: 10,
                    cacheRead: 20,
                    cacheWrite: 5,
                    totalTokens: 135,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costs.first },
                  },
                }),
              );
              await completed.appendMessageAsync(
                makeTextToolResult("call-usage", "read", "usage result", false, 22),
              );
              const leafId = await completed.appendMessageAsync(
                makeAgentAssistantMessage({
                  content,
                  provider: "anthropic",
                  model: "claude-reported",
                  timestamp: 23,
                  usage: {
                    input: 200,
                    output: 30,
                    cacheRead: 40,
                    cacheWrite: 0,
                    contextUsage: {
                      state: "available",
                      promptTokens: 240,
                      totalTokens: 270,
                    },
                    totalTokens: 270,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costs.last },
                  },
                }),
              );
              return fx.acknowledgeCompletedWorkerTurn(request.turnClaim, leafId);
            }),
            reconcileWorkspace: vi.fn(fx.reconcileUnchangedLocalWorkspace),
          }),
        ),
      });
      const provider = fx.createWorkerSessionTurnPlacementProvider({
        environments,
        placements: fx.placements,
      });

      const result = await provider.executeTurn(
        runIdentity("run-worker-usage"),
        { ...fx.turn("run-worker-usage"), toolsAllow: ["read"] },
        localResult,
      );

      expect(result.meta.finalAssistantVisibleText ?? "").toBe(visibleText ?? "");
      expect(result.meta.finalAssistantRawText).toBe(rawText);
      expect(result.meta.terminalReply).toEqual(terminalReply);
      expect(result.meta.systemPromptReport).toMatchObject({
        source: "run",
        sessionId: fx.SESSION_ID,
        sessionKey: fx.SESSION_KEY,
      });
      // Code Mode presents wrappers around the permitted read tool.
      expect(result.meta.systemPromptReport?.tools.entries.map(({ name }) => name)).toEqual([
        "exec",
        "wait",
      ]);
      const payloadTexts = result.payloads?.map((payload) => payload.text) ?? [];
      expect(payloadTexts).toEqual(visibleText ? [visibleText] : []);
      expect(result.meta.agentMeta).toEqual({
        sessionId: fx.SESSION_ID,
        sessionFile: fx.sessionFile,
        provider: "anthropic",
        model: "claude-reported",
        costUsd: costs.total,
        usage: {
          input: 300,
          output: 40,
          cacheRead: 60,
          cacheWrite: 5,
          total: 405,
          cost: { total: costs.total },
        },
        lastCallUsage: {
          input: 200,
          output: 30,
          cacheRead: 40,
          cacheWrite: 0,
          contextUsage: {
            state: "available",
            promptTokens: 240,
            totalTokens: 270,
          },
          total: 270,
          cost: { total: costs.last },
        },
        promptTokens: 240,
      });
    },
  );
});
