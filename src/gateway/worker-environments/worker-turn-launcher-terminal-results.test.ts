import fs from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkerLiveEventParamsSchema,
  type WorkerLiveEventParams,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { buildAgentRunTerminalReplySnapshot } from "../../agents/agent-run-terminal-reply.js";
import type { AgentRunTerminalReplySnapshot } from "../../agents/agent-run-terminal-reply.types.js";
import { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent-runner/run.js";
import { waitForEmbeddedAgentRunEnd } from "../../agents/embedded-agent-runner/runs.js";
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
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { NodeWorkerWorkspaceTransferError } from "../../worker/node-workspace-transfer-protocol.js";
import { createGatewayWorkerDispatchAdmission } from "../server-worker-placement-dispatch-admission.js";
import { createGatewayWorkerPlacementMoveBarrier } from "../server-worker-placement-move-barrier.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "../server-worker-placement-reclaim.js";
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
import {
  WorkerTurnExecutionError,
  WorkerWorkspaceReconciliationError,
} from "./worker-turn-failure.js";
import {
  createWorkerTurnTunnel,
  reconcileUnchangedLocalWorkspace,
  acknowledgeCompletedWorkerTurn,
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  credential,
  database as launcherDatabase,
  openSessionManager,
  createWorkerTurnSessionRuntimeLoader,
  placements,
  root,
  seedActivePlacement,
  sessionFile,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { gitInit } from "./workspace-recovery.test-support.js";

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
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  const completedWorkerMessage = () =>
    makeAgentAssistantMessage({
      content: [{ type: "text", text: "Remote work completed" }],
      timestamp: 21,
    });

  it.each<{
    stopReason: "stop" | "error";
    reconciliationFails: boolean;
    cleanupFailure?: string;
    providerFailure?: true;
  }>([
    { stopReason: "stop", reconciliationFails: false },
    { stopReason: "error", reconciliationFails: false },
    { stopReason: "stop", reconciliationFails: true },
    { stopReason: "error", reconciliationFails: true },
    { stopReason: "error", reconciliationFails: false, providerFailure: true },
    ...[
      "Browser cleanup timed out",
      "Browser cleanup failed: rate limit exceeded",
      "Browser disposal failed",
    ].map((cleanupFailure) => ({
      stopReason: "stop" as const,
      reconciliationFails: false,
      cleanupFailure,
    })),
  ])(
    "retains the ACKed finishing outcome after assistant $stopReason (reconciliation fails: $reconciliationFails; cleanup: $cleanupFailure; provider fallback: $providerFailure)",
    async ({ stopReason, reconciliationFails, cleanupFailure, providerFailure }) => {
      const outerFallback = cleanupFailure !== undefined || providerFailure === true;
      await seedActivePlacement();
      const grant = credential();
      const environment = attachedEnvironment();
      const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      const gate = createWorkerSessionPlacementGate(placements);
      const getConfig = () => ({ session: { store: sessionTarget.storePath } });
      const liveEvents = createWorkerLiveEventReceiver();
      const service = createWorkerEnvironmentService({
        scheduler: createTestGatewayScheduler(),
        store: {
          ...(await createWorkerEnvironmentStore({ database })),
          get: () => environment,
          getCredential: () => ({
            environmentId: ENVIRONMENT_ID,
            credentialHash: grant.deliveryId,
            bundleHash: grant.bundleHash,
            sessionId: SESSION_ID,
            rpcSetVersion: grant.rpcSetVersion,
            ownerEpoch: OWNER_EPOCH,
            expiresAtMs: grant.expiresAtMs,
            deliveredAtMs: Date.now(),
          }),
        },
        getConfig,
        resolveProvider: () => undefined,
        prepareInstallation: vi.fn(),
        bootstrapWorker: vi.fn(),
        inferenceStore: createWorkerInferenceStore({ path: database.path }),
        placementStore: gate,
        liveEvents,
      });
      const failure =
        cleanupFailure ??
        (providerFailure
          ? "provider rate limit exceeded"
          : "turn failed | provider failed | computer cleanup failed | native close failed");
      const effectFile = path.join(root, "worker-effects.txt");
      const launchedModels: string[] = [];
      const reconciliationError = new NodeWorkerWorkspaceTransferError("workspace transfer failed");
      const runId = "run-finishing-cleanup";
      // Real dispatch supplies the session-bound outer context before worker admission.
      const dispatchClaim = claimAgentRunContext(
        runId,
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
        },
        { ownsContext: true, trackOwner: true },
      );
      if (!dispatchClaim) {
        throw new Error("expected dispatch run context");
      }
      const workerTurn = turn(runId);
      let identity: WorkerConnectionIdentity;
      const tunnel = createWorkerTurnTunnel({
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
            await openSessionManager()
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
            environmentId: ENVIRONMENT_ID,
            credentialHash: grant.deliveryId,
            bundleHash: grant.bundleHash,
            sessionId: SESSION_ID,
            runId,
            turnClaim: request.turnClaim,
            ownerEpoch: OWNER_EPOCH,
            rpcSetVersion: grant.rpcSetVersion,
            protocolFeatures: environment.bootstrapReceipt!.protocolFeatures,
            credentialExpiresAtMs: grant.expiresAtMs,
          };
          const finishing = {
            runEpoch: OWNER_EPOCH,
            lastAckedSeq: 0,
            seq: 2,
            runId,
            event: {
              kind: "lifecycle" as const,
              payload: {
                phase: "finishing" as const,
                endedAt: 2,
                stopReason: "error" as const,
                error: failure,
                ...(cleanupFailure ? { replayInvalid: true as const } : {}),
              },
            },
          } satisfies WorkerLiveEventParams;
          expect(Value.Check(WorkerLiveEventParamsSchema, finishing)).toBe(true);
          await expect(service.pushLiveEvent(identity, finishing)).resolves.toEqual({
            ok: true,
            result: { ackedSeq: 0 },
          });
          expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(0);
          await expect(
            service.pushLiveEvent(identity, {
              ...finishing,
              event: {
                ...finishing.event,
                payload: {
                  ...finishing.event.payload,
                  error: "duplicate must not replace original",
                  replayInvalid: undefined,
                },
              },
            }),
          ).resolves.toEqual({ ok: true, result: { ackedSeq: 0 } });
          await expect(
            service.pushLiveEvent(identity, {
              ...finishing,
              seq: 1,
              event: { kind: "lifecycle", payload: { phase: "start", startedAt: 1 } },
            }),
          ).resolves.toEqual({ ok: true, result: { ackedSeq: 2 } });
          expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(1);
          return {
            stdout: JSON.stringify({
              status: "failed",
              reason: "turn-failed",
              transcriptLeafId: leafId,
              transcriptNextSeq: 3,
            }),
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
            termination: "exit",
          };
        }),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(async (request) => {
          if (reconciliationFails) {
            throw reconciliationError;
          }
          if (request.source.kind !== "local") {
            throw new Error("expected local workspace source");
          }
          await request.source.journal.commit(MANIFEST_REF);
          return {
            manifestRef: MANIFEST_REF,
            changed: false,
            verifyStable: async () => {},
            verifyLocalStable: async () => {},
            publishStagedResult: async () => {},
            discardPreparedStagedResult: async () => {},
          };
        }),
      }) satisfies WorkerTunnelHandle;
      const environments: WorkerTurnEnvironmentService = {
        ...unusedEnvironments(),
        get: vi.fn(() => environment),
        acquireTurnCredential: vi.fn(async (claim) => {
          grant.turnClaim = claim;
          grant.deliveryId = hashWorkerCredential(grant.credential, claim);
          return grant;
        }),
        acknowledgeCredentialDelivery: vi.fn(async () => true),
        startTunnel: vi.fn(async () => tunnel),
        destroy: vi.fn(async () => environment),
      };
      const reconcileActivePlacement = vi.fn(async () => {
        const [pending] = await placements.listPendingWorkspaceResultsAsync();
        if (!pending) {
          throw new Error("expected pending workspace result");
        }
        expect(pending).toMatchObject({ sessionId: SESSION_ID, runId });
        await placements.failWorkspaceResultAndReleaseTurn(pending, reconciliationError);
      });
      const provider = createWorkerSessionTurnPlacementProvider({
        environments,
        placements,
        reconcileActivePlacement,
      });
      const uninstall = installSessionPlacementAdmissionProvider(provider);
      try {
        const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
        const execute = vi.fn(() =>
          provider.executeTurn(
            { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId },
            workerTurn,
            runLocal,
          ),
        );
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
        let mediaTasks = getGeneratedMediaTaskIdsForSessionKey(SESSION_KEY);
        const candidateFailures: unknown[] = [];
        const runCandidate = vi.fn((candidateProvider: string, model: string) => {
          mediaTasks = getGeneratedMediaTaskIdsForSessionKey(SESSION_KEY);
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
        });
        const runOuterEntry = () =>
          runEmbeddedAgentEntry({
            selection: {
              cfg: config,
              provider: "openai",
              model: "gpt-5.6-luna",
              manifestPlugins: [],
              fallbacksOverride: ["openai/gpt-5.6-sol"],
            },
            identity: { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId },
            harness: {
              workspaceDir: root,
              sessionKey: SESSION_KEY,
              preparation: { kind: "direct" },
              resolveRuntimeOverride: () => "openclaw",
            },
            // Use the command/RPC producer, not a test veto derived from the answer.
            behavior: {
              kind: "command-rpc",
              hasCommittedSideEffect: () =>
                hasNewGeneratedMediaTaskForSessionKey(SESSION_KEY, mediaTasks),
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
        if (outerFallback) {
          expect(candidateFailures[0]).toBeInstanceOf(WorkerTurnExecutionError);
          expect(candidateFailures[0]).toMatchObject({ message: failure });
          expect(tunnel.reconcileWorkspace).toHaveBeenCalledOnce();
          expect((await openSessionManager()).getLeafEntry()).toMatchObject({
            type: "message",
            message: {
              role: "assistant",
              stopReason,
              content: providerFailure ? [] : [{ type: "text", text: "Remote answer" }],
            },
          });
          expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
          expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(0);
          expect(environments.destroy).not.toHaveBeenCalled();
          if (providerFailure) {
            expect(launchedModels).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
            expect(runCandidate).toHaveBeenCalledTimes(2);
            expect(observed).toMatchObject({ message: "Unexpected second worker execution" });
            await expect(fs.stat(effectFile)).rejects.toMatchObject({ code: "ENOENT" });
            return;
          }
          expect
            .soft(launchedModels, "cleanup must not replay the committed worker effect")
            .toEqual(["gpt-5.6-luna"]);
          expect.soft(await fs.readFile(effectFile, "utf8")).toBe("effect\n");
          expect.soft(runCandidate).toHaveBeenCalledOnce();
          expect.soft(observed).toBe(candidateFailures[0]);
          return;
        }
        expect(observed).toMatchObject({ message: expect.stringContaining(failure) });
        if (reconciliationFails) {
          expect(observed).toMatchObject({ cause: expect.any(WorkerWorkspaceReconciliationError) });
          expect(observed).toMatchObject({ cause: { cause: reconciliationError } });
          expect(resolveModelFallbackError(observed)).toEqual({
            kind: "coordination",
            error: observed,
          });
          expect(reconcileActivePlacement).toHaveBeenCalledExactlyOnceWith(ENVIRONMENT_ID);
        } else {
          expect(observed).toMatchObject({ message: failure });
          expect(reconcileActivePlacement).not.toHaveBeenCalled();
        }
        expect(execute).toHaveBeenCalledOnce();
        expect(tunnel.launchTurn).toHaveBeenCalledOnce();
        expect(runLocal).not.toHaveBeenCalled();
        expect(placements.get(SESSION_ID)).toMatchObject({
          state: reconciliationFails ? "failed" : "active",
          turnClaim: null,
        });
        expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(0);
        expect(environments.destroy).not.toHaveBeenCalled();
        await expect(
          service.pushLiveEvent(identity!, {
            runEpoch: OWNER_EPOCH,
            lastAckedSeq: 2,
            seq: 2,
            runId,
            event: {
              kind: "lifecycle",
              payload: { phase: "finishing", endedAt: 3, error: "late" },
            },
          }),
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
    await seedActivePlacement();
    const stopController = new AbortController();
    const claimWaitCleanup = new AbortController();
    const transferEntered = createDeferredCore();
    const failTransfer = createDeferredCore();
    const claimWaitEntered = createDeferredCore();
    const targetedAdmission = createDeferredCore();
    const destroy = vi.fn(async () => attachedEnvironment());
    const tunnelFailure = new NodeWorkerWorkspaceTransferError(
      "workspace-transfer-failed: gateway TLS fingerprint mismatch",
    );
    const targetRecovery = vi.fn(async () => {
      const [pending] = await placements.listPendingWorkspaceResultsAsync();
      if (!pending) {
        throw new Error("expected pending workspace result");
      }
      await placements.failWorkspaceResultAndReleaseTurn(pending, tunnelFailure);
    });
    const stopCleanup = vi.fn(async () => ({
      ...LOCAL_PLACEMENT,
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
    }));
    const waitForClaim = placements.waitForTurnClaimRelease;
    vi.spyOn(placements, "waitForTurnClaimRelease").mockImplementation((sessionId, options) => {
      const pending = waitForClaim(sessionId, { ...options, signal: claimWaitCleanup.signal });
      claimWaitEntered.resolve();
      return pending;
    });
    const entry = { sessionId: SESSION_ID, updatedAt: 1 };
    const barriers = createGatewayWorkerPlacementReclaimBarriers({
      placements,
      loadSessionRuntime: async () => ({
        managedWorktrees: { findLiveByOwner: async () => undefined },
        resolveGatewaySessionStoreTargetWithStore: () => ({
          storePath: sessionTarget.storePath,
          canonicalKey: SESSION_KEY,
          storeKeys: [SESSION_KEY],
          agentId: "main",
          store: { [SESSION_KEY]: entry },
        }),
        resolveCanonicalSessionEntryFromStoreKeys: () => entry,
      }),
      cancelSessionWork: async ({ assertCurrent }) => {
        assertCurrent();
        stopController.abort(new Error("Stop requested"));
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
          const pending = admit ? admit([SESSION_ID], targetRecovery) : targetRecovery();
          targetedAdmission.resolve();
          await pending;
        },
      }),
      (_request, run) => run(),
    );
    const tunnel: WorkerTunnelHandle = createWorkerTurnTunnel({
      launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
        request.onDispatchReady?.();
        const completed = await openSessionManager();
        const leafId = await completed.appendMessageAsync(completedWorkerMessage());
        return acknowledgeCompletedWorkerTurn(request.turnClaim, leafId);
      }),
      reconcileWorkspace: vi.fn(async () => {
        transferEntered.resolve();
        await failTransfer.promise;
        throw tunnelFailure;
      }),
    });
    const environments: WorkerTurnEnvironmentService = {
      ...unusedEnvironments(),
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery: vi.fn(async () => true),
      startTunnel: vi.fn(async () => tunnel),
      destroy,
    };
    const reconcileActivePlacement = vi.fn(dispatch.reconcileActive);
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
      reconcileActivePlacement,
    });

    const workerTurn = {
      ...turn("run-reconcile-tunnel-loss"),
      abortSignal: stopController.signal,
    };
    const running = provider
      .executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-reconcile-tunnel-loss",
        },
        workerTurn,
        async () => ({ meta: { durationMs: 1 } }),
      )
      .catch((error: unknown) => error);
    await transferEntered.promise;
    const stopping = dispatch
      .reclaim({ sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main" })
      .catch((error: unknown) => error);
    try {
      await claimWaitEntered.promise;
      expect(placements.get(SESSION_ID)?.turnClaim).not.toBeNull();
      failTransfer.resolve();
      await targetedAdmission.promise;
      // An unrelated completed dispatch gives admitted recovery a deterministic progress
      // boundary; a Stop that reserved this session too early leaves recovery unentered.
      await dispatch.dispatch({ ...REQUEST, sessionId: "unrelated" });
      expect(targetRecovery).toHaveBeenCalledOnce();
      await expect(running).resolves.toMatchObject({
        payloads: [{ text: "Remote work completed" }],
      });
      await expect(stopping).resolves.toMatchObject({ state: "local", sessionId: SESSION_ID });
      await waitForEmbeddedAgentRunEnd(SESSION_ID, null);
      expect(stopCleanup).toHaveBeenCalledOnce();
    } finally {
      failTransfer.resolve();
      // Failure cleanup aborts only the waiter; recovery remains the sole claim-release owner.
      claimWaitCleanup.abort();
      await Promise.all([running, stopping]);
      await waitForEmbeddedAgentRunEnd(SESSION_ID, null);
      workerTurn.preparedRunAdmission.close();
    }

    expect(reconcileActivePlacement).toHaveBeenCalledWith(ENVIRONMENT_ID);
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "failed", turnClaim: null });
    expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(0);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("recovers a durable Move result after its caller receives the final reply", async () => {
    await seedActivePlacement();
    await gitInit(root);
    const source = placements.get(SESSION_ID);
    if (source?.state !== "active") {
      throw new Error("Expected active source");
    }
    const request = {
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      source: {
        generation: source.generation,
        environmentId: source.environmentId,
        ownerEpoch: source.activeOwnerEpoch,
      },
      target: { kind: "gateway" as const },
    };
    const claimWaitCleanup = new AbortController();
    const transferEntered = createDeferredCore();
    const failTransfer = createDeferredCore();
    const barrierEntered = createDeferredCore();
    const startBarrier = createDeferredCore();
    const claimWaitEntered = createDeferredCore();
    const turnAbort = new AbortController();
    const targetedAdmission = createDeferredCore();
    const recoverySettled = createDeferredCore();
    const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
    const completeResult = vi.spyOn(placements, "completeWorkspaceResultAndReleaseTurn");
    const destroy = vi.fn(async () => attachedEnvironment());
    const tunnelFailure = new NodeWorkerWorkspaceTransferError(
      "workspace-transfer-failed: gateway TLS fingerprint mismatch",
    );
    const recoveryEntered = vi.fn((_mode?: "results-only") => {});
    const harness = createHarness(launcherDatabase, placements, {
      workspacePath: root,
      workspaceOperations,
    });
    vi.mocked(harness.environments.get).mockReturnValue(attachedEnvironment());
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
    const waitForClaim = placements.waitForTurnClaimRelease;
    vi.spyOn(placements, "waitForTurnClaimRelease").mockImplementation((sessionId, options) => {
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
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "draining", turnClaim: null });
      throw new Error("fixture: Move barrier complete");
    });
    const loadSessionRuntime = createWorkerTurnSessionRuntimeLoader();
    const moveBarrier = createGatewayWorkerPlacementMoveBarrier({
      placements,
      loadSessionRuntime,
      revokeSessionAuthority: () => {},
      awaitTurnClaimRelease: (sessionId, wait) => dispatch.awaitTurnClaimRelease(sessionId, wait),
    });
    const moveService = createWorkerPlacementMoveService({
      placements,
      environments: { get: () => attachedEnvironment() },
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
        forceDestroyEnvironment: async () => attachedEnvironment(),
        getEnvironmentAttachedSessionIds: () => ["unrelated"],
        readEnvironmentSessionIds: async () => ["unrelated"],
        move: moveService.move,
      },
      admit,
    );
    const tunnel = createWorkerTurnTunnel({
      launchTurn: vi.fn(async (launchRequest): Promise<SpawnResult> => {
        launchRequest.onDispatchReady?.();
        // A prior Move can fail its admission drain before terminal ACK. Its exact retry
        // joins the durable intent, while the admitted worker retains its original claim.
        await placements.beginPlacementMove(request);
        const completed = await openSessionManager();
        const leafId = await completed.appendMessageAsync(completedWorkerMessage());
        return acknowledgeCompletedWorkerTurn(launchRequest.turnClaim, leafId);
      }),
      reconcileWorkspace: vi
        .fn(reconcileUnchangedLocalWorkspace)
        .mockImplementationOnce(async () => {
          transferEntered.resolve();
          await failTransfer.promise;
          throw tunnelFailure;
        }),
    });
    vi.mocked(harness.environments.startTunnel).mockResolvedValue(tunnel);
    const environments: WorkerTurnEnvironmentService = {
      ...unusedEnvironments(),
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery: vi.fn(async () => true),
      startTunnel: vi.fn(async () => tunnel),
      destroy,
    };
    const reconcileActivePlacement = vi.fn(dispatch.reconcileActive);
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
      reconcileActivePlacement,
      workspaceOperations,
    });

    const workerTurn = turn("run-reconcile-tunnel-loss");
    const admission = await beginSessionWorkAdmission({
      scope: sessionTarget.storePath,
      identities: [SESSION_KEY, SESSION_ID],
      assertAllowed: () => {},
      onInterrupt: (reason) => {
        turnAbort.abort(reason);
      },
    });
    const running = admission
      .run(() =>
        provider.executeTurn(
          {
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
            agentId: "main",
            runId: "run-reconcile-tunnel-loss",
          },
          { ...workerTurn, abortSignal: turnAbort.signal },
          async () => ({ meta: { durationMs: 1 } }),
        ),
      )
      .finally(() => admission.release())
      .catch((error: unknown) => error);
    await transferEntered.promise;
    await expect(running).resolves.toMatchObject({
      payloads: [{ text: "Remote work completed" }],
    });
    expect(placements.get(SESSION_ID)?.state).toBe("draining");
    expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(1);
    const moving = dispatch.move(request).catch((error: unknown) => error);
    try {
      await barrierEntered.promise;
      startBarrier.resolve();
      await claimWaitEntered.promise;
      expect(turnAbort.signal.aborted).toBe(false);
      failTransfer.resolve();
      await targetedAdmission.promise;
      await dispatch.forceDestroyEnvironment("unrelated");
      expect(recoveryEntered).toHaveBeenCalledOnce();
      expect(recoveryEntered).toHaveBeenCalledWith("results-only");
      await recoverySettled.promise;
      expect(completeResult).toHaveBeenCalledOnce();
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
      await expect(moving).resolves.toMatchObject({
        message: "fixture: Move barrier complete",
      });
      expect(reclaimSource).toHaveBeenCalledOnce();
      await waitForEmbeddedAgentRunEnd(SESSION_ID, null);
    } finally {
      failTransfer.resolve();
      startBarrier.resolve();
      admission.release();
      // Failure cleanup aborts only the waiter; recovery remains the sole claim-release owner.
      claimWaitCleanup.abort();
      await Promise.all([running, moving]);
      await waitForEmbeddedAgentRunEnd(SESSION_ID, null);
      workerTurn.preparedRunAdmission.close();
    }

    expect(reconcileActivePlacement).toHaveBeenCalledWith(ENVIRONMENT_ID);
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "draining", turnClaim: null });
    expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(0);
    expect(tunnel.reconcileWorkspace).toHaveBeenCalledTimes(2);
    expect(harness.environments.startTunnel).toHaveBeenCalledOnce();
    expect(harness.reportWorkspaceResultRecoveryFailure).not.toHaveBeenCalled();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it.each<{
    name: string;
    content: Parameters<typeof makeAgentAssistantMessage>[0]["content"];
    visibleText?: string;
    rawText?: string;
    terminalReply: AgentRunTerminalReplySnapshot;
    costs?: { first: number; last: number; total: number };
  }>([
    {
      name: "visible final answer",
      costs: { first: 0.125, last: 0.25, total: 0.375 },
      content: [
        { type: "thinking", thinking: "Private reasoning" },
        {
          type: "text",
          text: "Working...",
          textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text: "Usage reply",
          textSignature: JSON.stringify({ v: 1, id: "final", phase: "final_answer" }),
        },
      ],
      visibleText: "Usage reply",
      rawText: "Usage reply",
      terminalReply: { disposition: "visible", text: "Usage reply" },
    },
    {
      name: "sanitized final answer",
      content: [{ type: "text", text: "<think>Private reasoning</think>Usage reply" }],
      visibleText: "Usage reply",
      rawText: "<think>Private reasoning</think>Usage reply",
      terminalReply: { disposition: "visible", text: "Usage reply" },
    },
    {
      name: "explicit silence",
      content: [{ type: "text", text: "NO_REPLY" }],
      visibleText: "NO_REPLY",
      rawText: "NO_REPLY",
      terminalReply: { disposition: "silent" },
    },
    {
      name: "reasoning-only completion",
      content: [{ type: "thinking", thinking: "Private reasoning" }],
      terminalReply: { disposition: "empty" },
    },
    {
      name: "tool-only completion",
      content: [{ type: "toolCall", id: "call-final", name: "read", arguments: {} }],
      terminalReply: { disposition: "empty" },
    },
    {
      name: "empty final answer",
      content: [],
      terminalReply: { disposition: "empty" },
    },
  ])(
    "reports canonical usage and $name",
    async ({
      content,
      visibleText,
      rawText,
      terminalReply,
      costs = { first: 0, last: 0, total: 0 },
    }) => {
      await seedActivePlacement();
      const environments: WorkerTurnEnvironmentService = {
        get: vi.fn(() => attachedEnvironment()),
        acquireTurnCredential: vi.fn(async () => credential()),
        acknowledgeCredentialDelivery: vi.fn(async () => true),
        startTunnel: vi.fn(async () =>
          createWorkerTurnTunnel({
            launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
              request.onDispatchReady?.();
              const completed = await openSessionManager();
              await completed.appendMessageAsync(
                makeAgentAssistantMessage({
                  content: [{ type: "toolCall", id: "call-usage", name: "read", arguments: {} }],
                  provider: "openai",
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
              return acknowledgeCompletedWorkerTurn(request.turnClaim, leafId);
            }),
            reconcileWorkspace: vi.fn(reconcileUnchangedLocalWorkspace),
          }),
        ),
        stopTunnel: vi.fn(async () => {}),
        destroy: vi.fn(async () => attachedEnvironment()),
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });

      const result = await provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-worker-usage",
        },
        turn("run-worker-usage"),
        async () => ({ meta: { durationMs: 1 } }),
      );

      expect(result.meta.finalAssistantVisibleText).toBe(visibleText);
      expect(result.meta.finalAssistantRawText).toBe(rawText);
      expect(
        buildAgentRunTerminalReplySnapshot({
          visibleText: result.meta.finalAssistantVisibleText,
          rawText: result.meta.finalAssistantRawText,
        }),
      ).toEqual(terminalReply);
      expect(result.meta.agentMeta).toEqual({
        sessionId: SESSION_ID,
        sessionFile,
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
