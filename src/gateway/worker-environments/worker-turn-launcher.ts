import { randomUUID } from "node:crypto";
import { isAgentRunRestartAbortReason } from "../../agents/run-termination.js";
import type { SandboxContext } from "../../agents/sandbox/types.js";
import type {
  LocalTurnPlacementClaim,
  SessionPlacementAdmissionProvider,
} from "../../agents/session-placement-admission.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitAgentRunStatusEvent } from "../../infra/agent-run-status-events.js";
import { markDiagnosticRunProgress } from "../../logging/diagnostic-run-activity.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { WORKER_ADMISSION_DEADLINE_MS } from "../../worker/worker-connection-contract.js";
import { StaleWorkerBuildError } from "./admission.js";
import { raceNodeWorkerOperation } from "./node-worker-abort.js";
import { placementTurnOwner, sameWorkerSessionTurnClaim } from "./placement-record.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";
import { matchesWorkerPlacementTarget } from "./placement-target.js";
import { ActiveTurnClaimError } from "./placement-turn-claims.js";
import { findPendingWorkerWorkspaceResult } from "./placement-workspace-result.js";
import { WorkerRuntimeRefreshPendingError } from "./provider-runtime-refresh.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import {
  WorkerRunnerCapacityError,
  WorkerRunnerUnavailableError,
  WorkerTunnelOwnerDisconnectedError,
} from "./tunnel-contract.js";
import {
  claimWorkerTurn,
  executeLocalTurn,
  releaseClaimIfOwned,
  requireActivePlacement,
  resolvePlacementIdentity,
  waitForPendingWorkerResult,
  waitForInitialWorkerPlacement,
  waitForWorkerRuntimeRefresh,
} from "./worker-turn-admission.js";
import {
  failHandedOffTurn,
  WorkerTurnExecutionError,
  WorkerWorkspaceReconciliationError,
  type ActiveWorkerPlacement,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-failure.js";
import { createWorkerTurnRunOwner, type ActiveWorkerTurn } from "./worker-turn-run-owner.js";
import type { WorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

const loadWorkerTurnExecution = createLazyRuntimeModule(() => import("./worker-turn-execution.js"));
const loadRemoteExecTurn = createLazyRuntimeModule(() => import("./workspace-result-finalize.js"));
const loadPlacementSandbox = createLazyRuntimeModule(() => import("./placement-sandbox.js"));

class WorkerRuntimeRefreshInFlightError extends Error {}

type RedispatchableWorkerPlacement = Extract<
  WorkerSessionPlacementRecord,
  { state: "reclaimed" | "failed" }
>;

type WorkerTurnLauncherOptions = {
  environments: WorkerTurnEnvironmentService;
  placements: WorkerSessionPlacementStore;
  /** Read-only resolution; a cancelled turn may stop waiting for these facts. */
  resolveWorkspace: (
    identity: ReturnType<typeof resolvePlacementIdentity>,
  ) => Promise<WorkerSessionWorkspace>;
  reconcileActivePlacement: (environmentId: string) => Promise<void>;
  waitForAdmissionNode: (params: {
    placement: ActiveWorkerPlacement;
    signal: AbortSignal;
    assertCurrent: () => void;
  }) => Promise<void>;
  workspaceOperations: WorkerWorkspaceOperationCoordinator;
  waitForInitialPlacement?: (
    placement: WorkerSessionPlacementRecord,
    signal?: AbortSignal,
  ) => Promise<WorkerSessionPlacementRecord>;
  redispatchPlacement: (
    placement: RedispatchableWorkerPlacement,
    options: { assertCurrent: () => void; signal?: AbortSignal },
  ) => Promise<ActiveWorkerPlacement>;
  prepareAcceptedWorkspacePublication?: (claim: WorkerSessionTurnClaim) => Promise<void>;
  publishAcceptedWorkspace?: (claim: WorkerSessionTurnClaim) => Promise<void>;
};

export function createWorkerSessionTurnPlacementProvider(options: WorkerTurnLauncherOptions) {
  const activeWorkerTurns = new Map<string, ActiveWorkerTurn>();
  const provider: SessionPlacementAdmissionProvider & {
    resolveSandbox(params: {
      agentId: string;
      config?: OpenClawConfig;
      sessionId: string;
      sessionKey?: string;
      workspaceDir: string;
    }): Promise<SandboxContext | null>;
  } = {
    resolveRuntimeOverride(identity) {
      const placement = options.placements.get(identity.sessionId);
      return placement &&
        placement.state !== "local" &&
        placement.executionMode === "worker-turn" &&
        (identity.agentId === undefined || placement.agentId === identity.agentId) &&
        (identity.sessionKey === undefined || placement.sessionKey === identity.sessionKey)
        ? "openclaw"
        : undefined;
    },
    assertCompactionSuccessorAllowed({ currentTarget }) {
      const placement = options.placements.get(currentTarget.sessionId);
      // Remote-exec has a local turn claim but still owns remote workspace state.
      // Only an absent or explicitly local placement can keep its exact cleanup on rotation.
      if (placement && placement.state !== "local") {
        throw new Error(
          "Compaction cannot change the session ID while a worker placement owns this session. " +
            "Keep the same session ID, or move the session back to the Gateway before retrying.",
        );
      }
    },
    recoverTerminalTurn(session) {
      const active = activeWorkerTurns.get(session.sessionId);
      return active && (!session.sessionKey || active.sessionKey === session.sessionKey)
        ? active.recoverTerminal?.()
        : undefined;
    },
    async resolveSandbox(params) {
      const placement = options.placements.get(params.sessionId);
      if (
        placement?.state !== "active" ||
        placement.executionMode !== "remote-exec" ||
        placement.agentId !== params.agentId ||
        placement.sessionKey !== params.sessionKey
      ) {
        return null;
      }
      const assertCurrentPlacement = (phase: "managed workspace" | "sandbox") => {
        const current = options.placements.get(params.sessionId);
        if (
          !matchesWorkerPlacementTarget(current, placement) ||
          current?.executionMode !== "remote-exec" ||
          current.agentId !== placement.agentId ||
          current.sessionKey !== placement.sessionKey
        ) {
          throw new Error(`Remote-exec placement changed while preparing its ${phase}`);
        }
      };
      const workspace = await options.resolveWorkspace({
        sessionId: placement.sessionId,
        agentId: placement.agentId,
        sessionKey: placement.sessionKey,
      });
      assertCurrentPlacement("managed workspace");
      const { createRemoteExecPlacementSandbox } = await loadPlacementSandbox();
      assertCurrentPlacement("sandbox");
      const sandbox = await createRemoteExecPlacementSandbox({
        config: params.config,
        environments: options.environments,
        workspaceDir: workspace.kind === "local" ? workspace.path : placement.remoteWorkspaceDir,
        placement,
      });
      assertCurrentPlacement("sandbox");
      const currentEnvironment = options.environments.get(placement.environmentId);
      if (
        currentEnvironment?.state !== "attached" ||
        currentEnvironment.environmentId !== placement.environmentId ||
        currentEnvironment.ownerEpoch !== placement.activeOwnerEpoch ||
        currentEnvironment.attachedSessionIds.length !== 1 ||
        currentEnvironment.attachedSessionIds[0] !== placement.sessionId ||
        (sandbox.backendId === "node" &&
          currentEnvironment.nodeDeviceId !== sandbox.placementNodeId)
      ) {
        throw new Error("Remote-exec environment changed while preparing its sandbox");
      }
      return sandbox;
    },
    async executeLocalTurn<T>(
      claim: LocalTurnPlacementClaim,
      runLocal: () => Promise<T>,
      assertCurrent?: () => void,
    ) {
      return await executeLocalTurn({
        claim,
        placements: options.placements,
        runLocal,
        assertCurrent,
      });
    },
    async executeTurn(claim, inputTurn, runLocal, onAdmitted, assertRunCurrent) {
      const restartSignal = getGatewayRestartDrainSignal();
      const runLocalTurn = () =>
        executeLocalTurn({
          claim,
          placements: options.placements,
          runLocal,
          assertCurrent: () => {
            inputTurn.abortSignal?.throwIfAborted();
            assertRunCurrent?.();
          },
        });
      const current = options.placements.get(claim.sessionId);
      if (!current && inputTurn.modelRun === true && !claim.sessionKey?.trim()) {
        return await runLocal();
      }
      if (!current || current.state === "local") {
        return await runLocalTurn();
      }
      const hasPendingWorkspaceResultToSettle = async (sessionId: string, runId: string) =>
        (await options.placements.listPendingWorkspaceResultsAsync(sessionId)).some(
          (pending) =>
            pending.sessionId === sessionId &&
            // A restarted run has no live claim, even when it reuses the retained run ID.
            (pending.runId !== runId || !options.placements.get(sessionId)?.turnClaim),
        );
      let identity = resolvePlacementIdentity(claim, current);
      const reportProvisioning = () =>
        emitAgentRunStatusEvent({
          runId: claim.runId,
          phase: "provisioning_environment",
          sessionKey: identity.sessionKey,
          agentId: identity.agentId,
        });
      let routablePlacement = current;
      let assertInitialSetupCurrent: (() => void) | undefined;
      // Every admission wait retains the caller's authority, not only initial setup.
      const assertAdmissionCurrent = () => {
        inputTurn.abortSignal?.throwIfAborted();
        assertRunCurrent?.();
        assertInitialSetupCurrent?.();
      };
      // An admission wait ends without authority; retry from the durable placement.
      const readRoutablePlacement = (message: string, cause?: unknown) => {
        assertAdmissionCurrent();
        const refreshed = options.placements.get(identity.sessionId);
        if (!refreshed) {
          throw new Error(message, cause === undefined ? undefined : { cause });
        }
        return refreshed;
      };
      let placement: ActiveWorkerPlacement;
      let turnClaim: WorkerSessionTurnClaim;
      let recoveredAdmission = false;
      let admissionReported = false;
      let userMessagePersisted = inputTurn.suppressNextUserMessagePersistence === true;
      for (;;) {
        // Remote-exec temporarily updates the caller's prompt for attachments.
        let turn = inputTurn;
        assertAdmissionCurrent();
        if (
          ["requested", "provisioning", "syncing", "starting"].includes(routablePlacement.state)
        ) {
          if (!options.waitForInitialPlacement) {
            throw new Error(
              "Worker setup has no live dispatch owner. Wait for recovery or explicitly retry setup.",
            );
          }
          reportProvisioning();
          const ready = await waitForInitialWorkerPlacement({
            placements: options.placements,
            placement: routablePlacement,
            turn,
            wait: options.waitForInitialPlacement,
            assertRunCurrent,
          });
          routablePlacement = ready.placement;
          assertInitialSetupCurrent = ready.assertCurrent;
        }
        if (
          routablePlacement.state === "reclaimed" ||
          (routablePlacement.state === "failed" && routablePlacement.activeOwnerEpoch !== null)
        ) {
          reportProvisioning();
          routablePlacement = await options.redispatchPlacement(routablePlacement, {
            assertCurrent: assertAdmissionCurrent,
            signal: inputTurn.abortSignal,
          });
          assertAdmissionCurrent();
          identity = resolvePlacementIdentity(
            { ...claim, agentId: identity.agentId, sessionKey: identity.sessionKey },
            routablePlacement,
          );
        }
        if (await hasPendingWorkspaceResultToSettle(identity.sessionId, claim.runId)) {
          await waitForPendingWorkerResult({
            placements: options.placements,
            sessionId: identity.sessionId,
            ...(turn.abortSignal ? { signal: turn.abortSignal } : {}),
          });
          const refreshed = readRoutablePlacement(
            "Cloud worker placement disappeared after workspace reconciliation",
          );
          if (refreshed.state === "local") {
            return await runLocalTurn();
          }
          routablePlacement = refreshed;
          continue;
        }
        placement = requireActivePlacement(routablePlacement);
        const environmentId = placement.environmentId;
        const refresh = options.environments.readRuntimeRefresh?.(environmentId);
        if (refresh) {
          reportProvisioning();
          await waitForWorkerRuntimeRefresh({
            refresh,
            ...(turn.abortSignal ? { signal: turn.abortSignal } : {}),
            timeoutMs: turn.timeoutMs,
            onProgress: () =>
              markDiagnosticRunProgress({
                sessionId: identity.sessionId,
                sessionKey: identity.sessionKey,
                runId: claim.runId,
                reason: "worker:runtime_refresh",
              }),
          });
          const refreshed = readRoutablePlacement(
            "Cloud worker placement disappeared while waiting for runtime refresh",
          );
          if (refreshed.state === "local") {
            return await runLocalTurn();
          }
          routablePlacement = refreshed;
          continue;
        }
        const assertClaimCurrent = () => {
          assertAdmissionCurrent();
          if (options.environments.readRuntimeRefresh?.(environmentId)) {
            throw new WorkerRuntimeRefreshInFlightError(
              "Worker runtime refresh started during turn admission",
            );
          }
        };
        const remoteExec = placement.executionMode === "remote-exec";
        let admitted: Awaited<ReturnType<typeof claimWorkerTurn>>;
        try {
          if (remoteExec) {
            admitted = {
              placement,
              turnClaim: await options.placements.claimTurn(
                {
                  ...identity,
                  claimId: randomUUID(),
                  runId: claim.runId,
                  owner: placementTurnOwner(placement),
                },
                assertClaimCurrent,
              ),
            };
          } else {
            admitted = await claimWorkerTurn({
              placements: options.placements,
              identity,
              placement,
              runId: claim.runId,
              assertCurrent: assertClaimCurrent,
              isCancellationRequested: (activeClaim) => {
                const active = activeWorkerTurns.get(activeClaim.sessionId);
                return Boolean(
                  active?.signal?.aborted && sameWorkerSessionTurnClaim(active.claim, activeClaim),
                );
              },
              ...(turn.abortSignal ? { signal: turn.abortSignal } : {}),
            });
          }
        } catch (error) {
          const refreshing = error instanceof WorkerRuntimeRefreshInFlightError;
          if (!refreshing) {
            if (
              !remoteExec ||
              !(error instanceof ActiveTurnClaimError) ||
              !(await hasPendingWorkspaceResultToSettle(identity.sessionId, claim.runId))
            ) {
              throw error;
            }
            await waitForPendingWorkerResult({
              placements: options.placements,
              sessionId: identity.sessionId,
              ...(turn.abortSignal ? { signal: turn.abortSignal } : {}),
            });
          }
          const refreshed = readRoutablePlacement(
            refreshing
              ? "Cloud worker placement disappeared during runtime refresh admission"
              : "Cloud worker placement disappeared after workspace reconciliation",
            error,
          );
          if (refreshed.state === "local") {
            return await runLocalTurn();
          }
          routablePlacement = refreshed;
          continue;
        }
        if (!admitted) {
          const refreshed = readRoutablePlacement(
            "Cloud worker placement disappeared after workspace reconciliation",
          );
          if (refreshed.state === "local") {
            return await runLocalTurn();
          }
          routablePlacement = refreshed;
          continue;
        }
        placement = admitted.placement;
        turnClaim = admitted.turnClaim;
        let activeWorkerTurn: ActiveWorkerTurn | undefined;
        let handedOff = false;
        let terminalReceiptRequired = false;
        let terminalAtMs: number | undefined;
        let workspaceResolutionFailed = false;
        try {
          if (!remoteExec) {
            activeWorkerTurn = await createWorkerTurnRunOwner({
              placements: options.placements,
              claim: turnClaim,
              sessionKey: placement.sessionKey,
              turn,
              assertCurrent: assertAdmissionCurrent,
            });
            activeWorkerTurn.signal.throwIfAborted();
            turn = {
              ...turn,
              abortSignal: activeWorkerTurn.signal,
              ...(userMessagePersisted ? { suppressNextUserMessagePersistence: true } : {}),
              onUserMessagePersisted: (message) => {
                userMessagePersisted = true;
                inputTurn.onUserMessagePersisted?.(message);
              },
            };
            activeWorkerTurns.set(turnClaim.sessionId, activeWorkerTurn);
          }
          const assertPreparationCurrent = () => {
            turn.abortSignal?.throwIfAborted();
            assertAdmissionCurrent();
            const preparedPlacement = options.placements.get(turnClaim.sessionId);
            if (
              preparedPlacement?.state !== "active" ||
              preparedPlacement.executionMode !== placement.executionMode ||
              !matchesWorkerPlacementTarget(preparedPlacement, placement) ||
              !options.placements.validateTurnClaim(turnClaim)
            ) {
              throw new Error("Worker placement changed while loading turn execution");
            }
            return preparedPlacement;
          };
          assertPreparationCurrent();
          // Worker-turn has a cancellation owner as soon as its durable run owner exists.
          // Remote-exec keeps the queued owner until the tunnel accepts process custody.
          if (!remoteExec && !admissionReported) {
            onAdmitted?.();
            admissionReported = true;
          }
          assertPreparationCurrent();
          // These preparations only read/resolve facts. Cancellation may stop
          // waiting, but no late result can enter execution after the exact owner closes.
          let workspace: WorkerSessionWorkspace;
          try {
            workspace = await raceNodeWorkerOperation(
              options.resolveWorkspace(identity),
              turn.abortSignal,
            );
          } catch (error) {
            workspaceResolutionFailed = true;
            await releaseClaimIfOwned(options.placements, turnClaim);
            throw error;
          }
          placement = assertPreparationCurrent();
          const execute = remoteExec
            ? (await raceNodeWorkerOperation(loadRemoteExecTurn(), turn.abortSignal))
                .executeRemoteExecTurn
            : (await raceNodeWorkerOperation(loadWorkerTurnExecution(), turn.abortSignal))
                .executeWorkerTurn;
          assertPreparationCurrent();
          const executionParams = {
            environments: options.environments,
            onHandoff: (custody?: { requiresTerminalReceipt: true }) => {
              if (!admissionReported) {
                onAdmitted?.();
                admissionReported = true;
              }
              handedOff = true;
              terminalReceiptRequired = custody?.requiresTerminalReceipt === true;
            },
            onTerminal: () => {
              terminalAtMs = Date.now();
            },
            placement,
            placements: options.placements,
            workspace,
            prepareAcceptedWorkspacePublication: options.prepareAcceptedWorkspacePublication,
            publishAcceptedWorkspace: options.publishAcceptedWorkspace,
            workspaceOperations: options.workspaceOperations,
            turn,
            turnClaim,
          };
          return await execute({
            ...executionParams,
            runLocal,
            assertRunCurrent: remoteExec ? assertRunCurrent : assertPreparationCurrent,
          });
        } catch (error) {
          if (workspaceResolutionFailed) {
            throw error;
          }
          const abortReason = turn.abortSignal?.reason;
          if (!remoteExec && restartSignal.aborted && isAgentRunRestartAbortReason(abortReason)) {
            // Keep the exact claim and pending result for startup's stop-and-recover owner.
            // Releasing here would allow a new turn before the old worker is settled.
            throw abortReason;
          }
          const disconnectedBeforeHandoff =
            !handedOff &&
            (error instanceof WorkerTunnelOwnerDisconnectedError ||
              error instanceof WorkerRunnerUnavailableError);
          if (
            error instanceof StaleWorkerBuildError ||
            error instanceof WorkerRuntimeRefreshPendingError ||
            disconnectedBeforeHandoff
          ) {
            const pendingResults = await options.placements.listPendingWorkspaceResultsAsync(
              placement.sessionId,
            );
            const canRecoverAdmission =
              !handedOff &&
              options.placements.validateTurnClaim(turnClaim) &&
              !pendingResults.some((pending) => pending.sessionId === placement.sessionId);
            if (canRecoverAdmission) {
              // This claim never launched work. Release it so runtime refresh does not
              // mistake admission for an executing turn that must finish first.
              try {
                assertAdmissionCurrent();
                turn.abortSignal?.throwIfAborted();
              } finally {
                await releaseClaimIfOwned(options.placements, turnClaim);
              }
              assertAdmissionCurrent();
              turn.abortSignal?.throwIfAborted();
              // Reconciliation may supersede the placement captured by initial setup.
              assertInitialSetupCurrent = undefined;
              if (!recoveredAdmission) {
                const waitTimeoutMs = Math.min(WORKER_ADMISSION_DEADLINE_MS, turn.timeoutMs);
                if (waitTimeoutMs <= 0) {
                  throw new WorkerRunnerUnavailableError();
                }
                const reconnect = new AbortController();
                const reconnectSignal = turn.abortSignal
                  ? AbortSignal.any([turn.abortSignal, reconnect.signal])
                  : reconnect.signal;
                const timeout = setTimeout(
                  () => reconnect.abort(new WorkerRunnerUnavailableError()),
                  waitTimeoutMs,
                );
                timeout.unref?.();
                const admissionFacts = await options.placements.prepareRuntimeRefresh(
                  placement.sessionId,
                );
                try {
                  markDiagnosticRunProgress({
                    sessionId: placement.sessionId,
                    sessionKey: identity.sessionKey,
                    runId: claim.runId,
                    reason: "worker:runtime_refresh",
                  });
                  reportProvisioning();
                  await options.waitForAdmissionNode({
                    placement,
                    signal: reconnectSignal,
                    assertCurrent: () => {
                      reconnectSignal.throwIfAborted();
                      assertAdmissionCurrent();
                      admissionFacts.assertCurrent();
                      const waitingPlacement = options.placements.get(placement.sessionId);
                      if (
                        !matchesWorkerPlacementTarget(waitingPlacement, placement) ||
                        waitingPlacement?.turnClaim ||
                        waitingPlacement?.sessionKey !== identity.sessionKey ||
                        waitingPlacement?.agentId !== identity.agentId ||
                        waitingPlacement?.executionMode !== placement.executionMode ||
                        admissionFacts.pendingResult
                      ) {
                        throw new Error(
                          "Worker placement changed while waiting for node admission",
                          { cause: error },
                        );
                      }
                    },
                  });
                } finally {
                  admissionFacts.release();
                  clearTimeout(timeout);
                }
              }
            }
            if (!disconnectedBeforeHandoff) {
              await options.reconcileActivePlacement(placement.environmentId);
            }
            const reconciled = options.placements.get(placement.sessionId);
            if (canRecoverAdmission) {
              assertAdmissionCurrent();
              turn.abortSignal?.throwIfAborted();
            }
            const refreshedInPlace =
              reconciled?.state === "active" &&
              matchesWorkerPlacementTarget(reconciled, placement) &&
              reconciled.turnClaim === null &&
              (disconnectedBeforeHandoff ||
                reconciled.workerBundleHash !== placement.workerBundleHash) &&
              reconciled.remoteWorkspaceDir === placement.remoteWorkspaceDir;
            const reclaimedSameOwner =
              reconciled?.state === "reclaimed" &&
              reconciled.environmentId === placement.environmentId &&
              reconciled.activeOwnerEpoch === placement.activeOwnerEpoch &&
              reconciled.generation === placement.generation + 3;
            if (
              canRecoverAdmission &&
              !recoveredAdmission &&
              (refreshedInPlace || reclaimedSameOwner) &&
              reconciled.executionMode === placement.executionMode &&
              reconciled.agentId === identity.agentId &&
              reconciled.sessionKey === identity.sessionKey
            ) {
              assertAdmissionCurrent();
              recoveredAdmission = true;
              routablePlacement = reconciled;
              continue;
            }
            if (canRecoverAdmission && reconciled?.state === "reclaimed") {
              throw error;
            }
            if (reconciled) {
              requireActivePlacement(reconciled);
            }
          }
          const pendingWorkspaceResult = await findPendingWorkerWorkspaceResult(
            options.placements,
            turnClaim,
          );
          if (pendingWorkspaceResult) {
            if (turnClaim.owner.kind === "local") {
              // The Gateway-owned run is already terminal. Atomically record the
              // reconciliation failure before teardown so reclaim cannot see live work.
              options.placements.failWorkspaceResultAndReleaseTurn(pendingWorkspaceResult, error);
            } else {
              // A recovery sweep owns the still-live worker claim. Teardown here
              // could discard the terminal event's durably fenced file results.
              await options.placements.handoffWorkspaceResultRecovery(turnClaim);
            }
            await options.reconcileActivePlacement(placement.environmentId);
            throw error;
          }
          if (
            error instanceof WorkerRunnerCapacityError ||
            (error instanceof WorkerRunnerUnavailableError && !handedOff) ||
            // An unconfirmed node cancellation must retain the teardown fence,
            // not reopen a reusable placement while its process may still run.
            (!remoteExec &&
              handedOff &&
              turn.abortSignal?.aborted &&
              (!terminalReceiptRequired || terminalAtMs !== undefined)) ||
            // Recovery precedes launch; only this admission claim belongs to the attempt.
            (error instanceof WorkerWorkspaceReconciliationError && !handedOff) ||
            (error instanceof WorkerTurnExecutionError &&
              options.placements.validateTurnClaim(turnClaim))
          ) {
            await releaseClaimIfOwned(options.placements, turnClaim);
            throw error;
          }
          const settledPlacement = options.placements.get(turnClaim.sessionId);
          if (
            (remoteExec || error instanceof WorkerTurnExecutionError) &&
            settledPlacement?.state === "active" &&
            settledPlacement.environmentId === placement.environmentId &&
            settledPlacement.activeOwnerEpoch === placement.activeOwnerEpoch &&
            settledPlacement.turnClaim === null
          ) {
            // Reconciliation already released this turn. Neither runtime's model
            // error may turn its reusable placement into box teardown.
            throw error;
          }
          if (handedOff) {
            const terminalOwner = activeWorkerTurn;
            await failHandedOffTurn({
              environments: options.environments,
              placements: options.placements,
              placement,
              turnClaim,
              error,
              ...(terminalOwner && terminalAtMs !== undefined
                ? {
                    terminal: {
                      observedAtMs: terminalAtMs,
                      registerRecovery: (recover: () => string | undefined) => {
                        terminalOwner.recoverTerminal = recover;
                      },
                    },
                  }
                : {}),
            });
          } else {
            await releaseClaimIfOwned(options.placements, turnClaim);
          }
          throw error;
        } finally {
          activeWorkerTurn?.dispose();
          if (activeWorkerTurn && activeWorkerTurns.get(turnClaim.sessionId) === activeWorkerTurn) {
            activeWorkerTurns.delete(turnClaim.sessionId);
          }
        }
      }
    },
  };
  return provider;
}
