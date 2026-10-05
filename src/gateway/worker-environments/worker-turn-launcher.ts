import { isAgentRunRestartAbortReason } from "../../agents/run-termination.js";
import type {
  LocalTurnPlacementClaim,
  SessionPlacementAdmissionProvider,
} from "../../agents/session-placement-admission.js";
import {
  composeSessionSourceAssertion,
  createDynamicSessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { markDiagnosticRunProgress } from "../../logging/diagnostic-run-activity.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { WORKER_ADMISSION_DEADLINE_MS } from "../../worker/worker-connection-contract.js";
import { StaleWorkerBuildError } from "./admission.js";
import { raceNodeWorkerOperation } from "./node-worker-abort.js";
import { recordWorkerPlacementAwait } from "./placement-diagnostics.js";
import { sameWorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerSessionTurnClaim } from "./placement-store.js";
import {
  isUnallocatedWorkerPlacementFailure,
  isWorkerPlacementDestroyedBeforeActivation,
  matchesWorkerPlacementTarget,
} from "./placement-target.js";
import { ActiveTurnClaimError } from "./placement-turn-claims.js";
import { findPendingWorkerWorkspaceResult } from "./placement-workspace-result.js";
import { WorkerRuntimeRefreshPendingError } from "./provider-runtime-refresh.js";
import { canRedispatchFailedWorkerPlacement } from "./session-placement-lifecycle.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import {
  WorkerRunnerCapacityError,
  WorkerRunnerUnavailableError,
  WorkerTunnelOwnerDisconnectedError,
} from "./tunnel-contract.js";
import {
  claimWorkerTurn,
  readWorkerTurnOperatorAuthority,
  readWorkerTurnPlacement,
  createWorkerTurnPlacementObservation,
  createWorkerTurnPreparationAssertion,
  executeLocalTurn,
  releaseClaimIfOwned,
  requireActivePlacement,
  resolvePlacementIdentity,
  resolveWorkerPlacementRuntimeOverride,
  waitForPendingWorkerResult,
  waitForInitialWorkerPlacement,
  waitForWorkerRuntimeRefresh,
} from "./worker-turn-admission.js";
import {
  waitForRecoveryWorkerCapacity,
  redispatchWithRecoveryCapacity,
  type RecoveryWorkerRetryIntent,
} from "./worker-turn-capacity.js";
import {
  failHandedOffTurn,
  WorkerTurnExecutionError,
  WorkerWorkspaceReconciliationError,
  type ActiveWorkerPlacement,
} from "./worker-turn-failure.js";
import type { WorkerTurnLauncherOptions } from "./worker-turn-launcher.types.js";
import { createWorkerTurnRunOwner, type ActiveWorkerTurn } from "./worker-turn-run-owner.js";
import { prepareWorkerTurnSandbox } from "./worker-turn-sandbox.js";
import { AcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";

const loadWorkerTurnExecution = createLazyRuntimeModule(() => import("./worker-turn-execution.js"));
const loadRemoteExecTurn = createLazyRuntimeModule(() => import("./workspace-result-finalize.js"));

class WorkerRuntimeRefreshInFlightError extends Error {}

export function createWorkerSessionTurnPlacementProvider(options: WorkerTurnLauncherOptions) {
  const activeWorkerTurns = new Map<string, ActiveWorkerTurn>();
  const provider: SessionPlacementAdmissionProvider & {
    prepareSandbox(
      params: Parameters<typeof prepareWorkerTurnSandbox>[1],
    ): ReturnType<typeof prepareWorkerTurnSandbox>;
  } = {
    resolveRuntimeOverride: (identity) =>
      resolveWorkerPlacementRuntimeOverride(options.placements, identity),
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
    async recoverTerminalTurn(session, assertCurrent) {
      const active = activeWorkerTurns.get(session.sessionId);
      return active && (!session.sessionKey || active.sessionKey === session.sessionKey)
        ? await active.recoverTerminal?.(() => {
            assertCurrent?.();
            if (activeWorkerTurns.get(session.sessionId) !== active) {
              throw new Error("Terminal worker recovery lost its active run owner");
            }
          })
        : undefined;
    },
    prepareSandbox: (params) => prepareWorkerTurnSandbox(options, params),
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
      const current = await readWorkerTurnPlacement({
        placements: options.placements,
        claim,
        signal: inputTurn.abortSignal,
        assertRunCurrent,
      });
      if (!current && inputTurn.modelRun === true && !claim.sessionKey?.trim()) {
        return await runLocal();
      }
      if (!current || current.state === "local") {
        return await runLocalTurn();
      }
      let identity = resolvePlacementIdentity(claim, current);
      let routablePlacement = current;
      let assertInitialSetupCurrent: (() => void) | undefined;
      // Every admission wait retains the caller's authority, not only initial setup.
      const initialSetupSource = createDynamicSessionSourceAssertion(
        () => assertInitialSetupCurrent,
        () => {
          throw new Error("Worker setup authority changed during turn admission");
        },
      );
      const assertAdmissionCurrent = composeSessionSourceAssertion(
        [assertRunCurrent, initialSetupSource],
        (assertSources) => {
          inputTurn.abortSignal?.throwIfAborted();
          assertSources();
        },
      );
      const { hasPendingWorkspaceResultToSettle, reportProvisioning, readRoutablePlacement } =
        createWorkerTurnPlacementObservation(
          options.placements,
          claim.runId,
          () => identity,
          assertAdmissionCurrent,
        );
      let placement: ActiveWorkerPlacement;
      let turnClaim: WorkerSessionTurnClaim;
      let recoveredAdmission = false;
      let admissionReported = false;
      let userMessagePersisted = inputTurn.suppressNextUserMessagePersistence === true;
      let retryIntent: RecoveryWorkerRetryIntent | undefined;
      try {
        for (;;) {
          // Remote-exec temporarily updates the caller's prompt for attachments.
          let turn = inputTurn;
          assertAdmissionCurrent();
          await retryIntent?.assertCurrent(assertAdmissionCurrent);
          const failedEnvironment =
            routablePlacement.state === "failed" && routablePlacement.environmentId
              ? options.environments.get(routablePlacement.environmentId)
              : undefined;
          const destroyedBeforeActivation = isWorkerPlacementDestroyedBeforeActivation(
            routablePlacement,
            failedEnvironment,
          );
          assertAdmissionCurrent();
          if (
            routablePlacement.state === "failed" &&
            !isUnallocatedWorkerPlacementFailure(routablePlacement) &&
            !canRedispatchFailedWorkerPlacement(routablePlacement, failedEnvironment) &&
            options.recoverFailedPlacement
          ) {
            routablePlacement = await options.recoverFailedPlacement(routablePlacement, {
              assertCurrent: assertAdmissionCurrent,
              signal: inputTurn.abortSignal,
              operatorAuthority: readWorkerTurnOperatorAuthority(inputTurn),
            });
            assertAdmissionCurrent();
          }
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
            (routablePlacement.state === "failed" &&
              (routablePlacement.activeOwnerEpoch !== null ||
                destroyedBeforeActivation ||
                isUnallocatedWorkerPlacementFailure(routablePlacement)))
          ) {
            reportProvisioning();
            const previousPlacement = routablePlacement;
            const dispatched = await redispatchWithRecoveryCapacity({
              environments: options.environments,
              placements: options.placements,
              sessionId: claim.sessionId,
              runId: claim.runId,
              turn: inputTurn,
              assertCurrent: assertAdmissionCurrent,
              dispatch: () =>
                options.redispatchPlacement(previousPlacement, {
                  assertCurrent: assertAdmissionCurrent,
                  signal: inputTurn.abortSignal,
                  operatorAuthority: readWorkerTurnOperatorAuthority(inputTurn),
                }),
            });
            routablePlacement = dispatched.placement;
            if (dispatched.retryIntent) {
              await retryIntent?.release();
              retryIntent = dispatched.retryIntent;
              continue;
            }
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
              reconcilePending: options.reconcileActivePlacement,
              ...(turn.abortSignal ? { signal: turn.abortSignal } : {}),
            });
            assertAdmissionCurrent();
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
            admitted = await claimWorkerTurn({
              placements: options.placements,
              identity,
              placement,
              runId: claim.runId,
              assertCurrent: assertClaimCurrent,
              reconcilePending: options.reconcileActivePlacement,
              isCancellationRequested: (activeClaim) => {
                const active = activeWorkerTurns.get(activeClaim.sessionId);
                return Boolean(
                  active?.signal?.aborted && sameWorkerSessionTurnClaim(active.claim, activeClaim),
                );
              },
              ...(turn.abortSignal ? { signal: turn.abortSignal } : {}),
            });
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
                reconcilePending: options.reconcileActivePlacement,
                sessionId: identity.sessionId,
                ...(turn.abortSignal ? { signal: turn.abortSignal } : {}),
              });
              assertAdmissionCurrent();
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
            const assertPreparationCurrent = createWorkerTurnPreparationAssertion({
              placements: options.placements,
              placement,
              turnClaim,
              assertAdmissionCurrent,
              signal: turn.abortSignal,
            });
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
              workspace = await recordWorkerPlacementAwait(
                placement.sessionId,
                "turn_workspace_resolve",
                () => raceNodeWorkerOperation(options.resolveWorkspace(identity), turn.abortSignal),
                {
                  generation: placement.generation,
                  environmentId: placement.environmentId,
                  ownerEpoch: placement.activeOwnerEpoch,
                  claimId: turnClaim.claimId,
                  runId: turnClaim.runId,
                },
                "placement",
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
            const { withWorkerTurnTranscriptDatabase } =
              await import("./worker-turn-transcript-target.js");
            assertPreparationCurrent();
            const executionOptions = {
              ...(retryIntent ? { assertRecoveryIntent: retryIntent.assertCurrent } : {}),
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
              resolveWorkspace: () => options.resolveWorkspace(identity),
              prepareAcceptedWorkspacePublication: options.prepareAcceptedWorkspacePublication,
              publishAcceptedWorkspace: options.publishAcceptedWorkspace,
              workspaceOperations: options.workspaceOperations,
              turn,
              turnClaim,
              runLocal,
              assertRunCurrent: remoteExec ? assertRunCurrent : assertPreparationCurrent,
            };
            return await withWorkerTurnTranscriptDatabase(
              turn,
              {
                assertCurrent: assertPreparationCurrent,
                prepareAuthority: () => options.placements.prepareTurnClaimAuthority(turnClaim),
                signal: turn.abortSignal,
              },
              () => execute(executionOptions),
            );
          } catch (error) {
            if (
              workspaceResolutionFailed ||
              error instanceof AcceptedWorkspacePublicationIndeterminateError
            ) {
              throw error;
            }
            const abortReason = turn.abortSignal?.reason;
            if (!remoteExec && restartSignal.aborted && isAgentRunRestartAbortReason(abortReason)) {
              // Keep the exact claim and pending result for startup's stop-and-recover owner.
              // Releasing here would allow a new turn before the old worker is settled.
              throw abortReason;
            }
            let retryCapacity: RecoveryWorkerRetryIntent | false = false;
            if (!remoteExec && error instanceof WorkerRunnerCapacityError && error.refusal) {
              try {
                retryCapacity = await waitForRecoveryWorkerCapacity({
                  environments: options.environments,
                  placements: options.placements,
                  claim: turnClaim,
                  turn,
                  refusal: error.refusal,
                  assertCurrent: assertAdmissionCurrent,
                });
              } catch (capacityError) {
                await releaseClaimIfOwned(options.placements, turnClaim);
                throw capacityError;
              }
            }
            if (retryCapacity) {
              const previousIntent = retryIntent;
              retryIntent = retryCapacity;
              try {
                await previousIntent?.release();
              } finally {
                // The exact node journal rejected admission without a child. Close
                // only this claim, then refresh all per-attempt credentials and grants.
                await releaseClaimIfOwned(options.placements, turnClaim);
              }
              assertAdmissionCurrent();
              continue;
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
                await options.placements.failWorkspaceResultAndReleaseTurn(
                  pendingWorkspaceResult,
                  error,
                );
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
                        registerRecovery: (recover) => {
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
            if (
              activeWorkerTurn &&
              activeWorkerTurns.get(turnClaim.sessionId) === activeWorkerTurn
            ) {
              activeWorkerTurns.delete(turnClaim.sessionId);
            }
          }
        }
      } finally {
        await retryIntent?.release();
      }
    },
  };
  return provider;
}
