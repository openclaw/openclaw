import type { Result } from "@openclaw/normalization-core/result";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { appendAgentRunFailure } from "../../agents/agent-run-result.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { recordModelFallbackStop } from "../../agents/failover-error.js";
import { resolveSandboxToolPolicyForAgent } from "../../agents/sandbox/tool-policy.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { withSessionPlacementComputer } from "../../agents/session-placement-computer.js";
import { withSessionSkillResources } from "../../agents/session-placement-skill-resources.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  attachErrorDiagnostic,
  formatErrorMessageForDisplay,
} from "../../infra/error-diagnostics.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { redactSensitiveText } from "../../logging/redact.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import type { PreparedWorkerComputer } from "./computer-transport.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";
import {
  createWorkerWorkspaceReconcileRequest,
  type WorkerSessionWorkspace,
} from "./session-workspace.js";
import { transferSkillResources } from "./skill-resource-transfer.js";
import { WorkerTunnelOwnerDisconnectedError, type WorkerTunnelHandle } from "./tunnel-contract.js";
import { latestDurableWorkspaceConflict, waitForTurnOperation } from "./worker-turn-admission.js";
import { prepareWorkerTurnAttachments } from "./worker-turn-attachments.js";
import { WorkerWorkspaceReconciliationError } from "./worker-turn-failure.js";
import { resolveWorkerTurnTranscriptTarget } from "./worker-turn-transcript-target.js";
import {
  formatWorkspaceConflictSummary,
  WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
  WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
} from "./workspace-conflicts.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import type { WorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { recoverWorkerWorkspaceReconciliation } from "./workspace-reconcile.js";
import {
  createWorkspaceResultJournal,
  finalizeWorkspaceResultConflicts,
  settleStagedWorkspaceResult,
} from "./workspace-result-settlement.js";
import { workerWorkspaceResultRef } from "./workspace-result-staging.js";

type ActiveWorkerPlacement = Extract<WorkerSessionPlacementRecord, { state: "active" }>;
type RemoteExecEnvironmentService = Pick<WorkerEnvironmentService, "get" | "startTunnel"> &
  Partial<Pick<WorkerEnvironmentService, "prepareComputer">>;

type WorkspaceConflictReport = {
  paths: string[];
  stagedResultRef: string;
  totalCount: number;
  summary: string;
};

function workspaceError(error: unknown): string {
  const message = redactSensitiveText(formatErrorMessage(error), { mode: "tools" })
    .replace(/\s+/gu, " ")
    .trim();
  return truncateUtf16Safe(message || "cloud worker turn failed", 1_024);
}

function retainRemoteExecCleanupFailure(error: unknown, diagnostic?: string): Error {
  // Preserve typed/abort identity, including frozen errors; display text never owns replay policy.
  const primary = error instanceof Error ? error : new Error(formatErrorMessage(error));
  recordModelFallbackStop(primary);
  return diagnostic
    ? attachErrorDiagnostic(primary, formatErrorMessageForDisplay(primary, diagnostic))
    : primary;
}

function remoteExecWorkspaceFailure(executionError: unknown, reconciliationError: unknown): Error {
  const executionMessage = formatErrorMessageForDisplay(executionError);
  const reconciliationDetail =
    reconciliationError instanceof WorkerWorkspaceReconciliationError &&
    reconciliationError.cause !== undefined
      ? reconciliationError.cause
      : reconciliationError;
  const reconciliationFailure = new WorkerWorkspaceReconciliationError(
    workspaceError(reconciliationDetail),
    { cause: reconciliationDetail },
  );
  return new Error(
    `${executionMessage}\n\nWorkspace recovery also failed: ${reconciliationFailure.message}. ` +
      "Remote changes may not have been applied locally. Resolve the workspace error, then retry.",
    // Keep the typed reconciliation failure discoverable so model fallback cannot replay the turn.
    { cause: reconciliationFailure },
  );
}

export async function recoverWorkspaceBeforeTurn(params: {
  placement: ActiveWorkerPlacement;
  placements: WorkerSessionPlacementStore;
  turnClaim: WorkerSessionTurnClaim;
  workspaceOperations: WorkerWorkspaceOperationCoordinator;
  workspace: WorkerSessionWorkspace;
}): Promise<void> {
  if (params.workspace.kind === "repository") {
    return;
  }
  const localWorkspaceDir = params.workspace.path;
  const journal = createWorkspaceResultJournal(params).adapter;
  try {
    await params.workspaceOperations.run(params.placement.environmentId, async () => {
      if (!params.placements.validateTurnClaim(params.turnClaim)) {
        throw new Error("Cloud worker workspace recovery lost its turn claim");
      }
      const pending = journal.load();
      if (pending) {
        await recoverWorkerWorkspaceReconciliation({
          root: localWorkspaceDir,
          journal: pending,
        });
        journal.abort();
      }
    });
  } catch (error) {
    throw new WorkerWorkspaceReconciliationError(
      `Cloud worker workspace recovery could not complete: ${workspaceError(error)}`,
      { cause: error },
    );
  }
}

export async function reconcileWorkspaceAfterTurn(params: {
  placement: ActiveWorkerPlacement;
  placements: WorkerSessionPlacementStore;
  turnClaim: WorkerSessionTurnClaim;
  workspaceOperations: WorkerWorkspaceOperationCoordinator;
  workspace: WorkerSessionWorkspace;
  transcriptTarget: Parameters<typeof SessionManager.open>[0];
  tunnel: WorkerTunnelHandle;
  prepareAcceptedWorkspacePublication?: (claim: WorkerSessionTurnClaim) => Promise<void>;
  publishAcceptedWorkspace?: (claim: WorkerSessionTurnClaim) => Promise<void>;
}): Promise<WorkspaceConflictReport | undefined> {
  const currentPlacement = params.placements.get(params.placement.sessionId);
  const generationMatches =
    currentPlacement?.state === "active"
      ? currentPlacement.generation === params.turnClaim.placementGeneration
      : currentPlacement?.state === "draining"
        ? currentPlacement.generation === params.turnClaim.placementGeneration + 1
        : false;
  if (
    (currentPlacement?.state !== "active" && currentPlacement?.state !== "draining") ||
    currentPlacement.environmentId !== params.placement.environmentId ||
    currentPlacement.activeOwnerEpoch !== params.placement.activeOwnerEpoch ||
    !generationMatches
  ) {
    throw new Error("Cloud worker placement changed before workspace reconciliation");
  }
  const completed = SessionManager.open(params.transcriptTarget);
  const priorWorkspaceConflict =
    currentPlacement.workspaceResultConflict ??
    latestDurableWorkspaceConflict(completed.getBranch());
  const pendingWorkspaceResult = params.placements
    .listPendingWorkspaceResults()
    .some(
      (pending) =>
        pending.sessionId === params.turnClaim.sessionId &&
        pending.claimId === params.turnClaim.claimId &&
        pending.runId === params.turnClaim.runId,
    );
  if (!pendingWorkspaceResult) {
    throw new Error("Cloud worker completed without a durable workspace-result fence");
  }
  const journal = createWorkspaceResultJournal({
    placement: currentPlacement,
    placements: params.placements,
    turnClaim: params.turnClaim,
  });
  let workspaceConflict: WorkspaceConflictReport | undefined;
  try {
    await params.workspaceOperations.run(currentPlacement.environmentId, async () => {
      if (!params.placements.validateTurnClaim(params.turnClaim)) {
        throw new Error("Cloud worker workspace result lost its turn claim");
      }
      const quiescence = await params.tunnel.quiesceWorkspace(currentPlacement.remoteWorkspaceDir);
      let resumed = false;
      try {
        const stagedResultRef = workerWorkspaceResultRef(params.turnClaim.claimId);
        const reconciliation = await params.tunnel.reconcileWorkspace(
          createWorkerWorkspaceReconcileRequest({
            workspace: params.workspace,
            remoteWorkspaceDir: currentPlacement.remoteWorkspaceDir,
            baseManifestRef: currentPlacement.workspaceBaseManifestRef,
            journal: journal.adapter,
            stagedResult: {
              ref: stagedResultRef,
              record: (ref) =>
                params.placements.recordStagedWorkspaceResult(
                  params.turnClaim,
                  ref,
                  params.workspace.kind === "repository"
                    ? params.workspace.repository.workspaceId
                    : undefined,
                ),
            },
            assertCurrent: () => {
              if (!params.placements.validateWorkspaceResultClaim(params.turnClaim)) {
                throw new Error("Cloud worker workspace result lost its placement owner");
              }
            },
          }),
        );
        const applied = await verifyReconciledWorkspaceFinal(reconciliation, quiescence);
        if (!journal.wasAccepted()) {
          throw new Error("Cloud worker workspace reconciliation was not durably accepted");
        }
        if (params.prepareAcceptedWorkspacePublication) {
          await params.prepareAcceptedWorkspacePublication(params.turnClaim).catch(() => undefined);
        }
        params.placements.acceptWorkspaceResult(params.turnClaim);
        const recordedStagedResultRef = params.placements
          .listPendingWorkspaceResults()
          .find(
            (pending) =>
              pending.sessionId === params.turnClaim.sessionId &&
              pending.claimId === params.turnClaim.claimId &&
              pending.runId === params.turnClaim.runId,
          )?.stagedResultRef;
        if (applied?.conflictPaths.length && !recordedStagedResultRef) {
          throw new Error("Cloud workspace conflict has no staged result reference");
        }
        const finalized = await finalizeWorkspaceResultConflicts({
          placements: params.placements,
          turnClaim: params.turnClaim,
          conflictPaths: applied?.conflictPaths ?? [],
          priorConflict: priorWorkspaceConflict,
          stagedResultRef: recordedStagedResultRef,
          workspace: params.workspace,
          report: async (report) => {
            if ("cleared" in report) {
              SessionManager.open(params.transcriptTarget).appendCustomMessageEntry(
                WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
                "A later cloud workspace result superseded the previous conflict.",
                false,
              );
              return;
            }
            workspaceConflict = {
              ...report,
              summary: formatWorkspaceConflictSummary(
                report.paths,
                report.stagedResultRef,
                report.totalCount,
              ),
            };
            SessionManager.open(params.transcriptTarget).appendCustomMessageEntry(
              WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
              workspaceConflict.summary,
              true,
              {
                paths: workspaceConflict.paths,
                stagedResultRef: workspaceConflict.stagedResultRef,
                totalCount: workspaceConflict.totalCount,
              },
            );
          },
        });
        await params.publishAcceptedWorkspace?.(params.turnClaim);
        await settleStagedWorkspaceResult({
          placements: params.placements,
          turnClaim: params.turnClaim,
          workspace: params.workspace,
          stagedResultRef: recordedStagedResultRef,
          conflictRetained: finalized.conflictRetained,
          beforeComplete: async () => {
            await quiescence.resume();
            resumed = true;
          },
        });
      } finally {
        if (!resumed) {
          await quiescence.resume();
        }
      }
    });
  } catch (error) {
    throw new WorkerWorkspaceReconciliationError(
      `Cloud worker finished, but its workspace result could not be reconciled: ${workspaceError(error)}`,
      { cause: error },
    );
  }
  return workspaceConflict;
}

function appendWorkspaceConflict(
  result: EmbeddedAgentRunResult,
  workspaceConflict: WorkspaceConflictReport,
): EmbeddedAgentRunResult {
  const payloads = result.payloads ? [...result.payloads] : [];
  const textIndex = payloads.findLastIndex((payload) => typeof payload.text === "string");
  if (textIndex === -1) {
    payloads.push({ text: workspaceConflict.summary });
  } else {
    const payload = payloads[textIndex]!;
    payloads[textIndex] = {
      ...payload,
      text: payload.text
        ? `${payload.text}\n\n${workspaceConflict.summary}`
        : workspaceConflict.summary,
    };
  }
  return { ...result, payloads };
}

export async function executeRemoteExecTurn(params: {
  environments: RemoteExecEnvironmentService;
  onHandoff: () => void;
  placement: ActiveWorkerPlacement;
  placements: WorkerSessionPlacementStore;
  workspaceOperations: WorkerWorkspaceOperationCoordinator;
  turn: SessionPlacementTurnParams;
  turnClaim: WorkerSessionTurnClaim;
  workspace: WorkerSessionWorkspace;
  runLocal: () => Promise<EmbeddedAgentRunResult>;
  assertRunCurrent?: () => void;
  prepareAcceptedWorkspacePublication?: (claim: WorkerSessionTurnClaim) => Promise<void>;
  publishAcceptedWorkspace?: (claim: WorkerSessionTurnClaim) => Promise<void>;
}): Promise<EmbeddedAgentRunResult> {
  const environment = params.environments.get(params.placement.environmentId);
  if (
    !environment ||
    environment.state !== "attached" ||
    environment.ownerEpoch !== params.placement.activeOwnerEpoch ||
    environment.bootstrapReceipt?.bundleHash !== params.placement.workerBundleHash ||
    environment.attachedSessionIds.length !== 1 ||
    environment.attachedSessionIds[0] !== params.placement.sessionId
  ) {
    throw new Error("Active remote-exec placement does not match its attached environment");
  }
  await recoverWorkspaceBeforeTurn(params);
  params.assertRunCurrent?.();
  const tunnel = await waitForTurnOperation({
    operation: params.environments.startTunnel({
      environmentId: params.placement.environmentId,
      ownerEpoch: params.placement.activeOwnerEpoch,
    }),
    ...(params.turn.abortSignal ? { signal: params.turn.abortSignal } : {}),
    timeoutMs: params.turn.timeoutMs,
  });
  const transcriptTarget = resolveWorkerTurnTranscriptTarget(params.turn);
  const attachmentNote = await prepareWorkerTurnAttachments({
    turn: params.turn,
    tunnel,
    remoteWorkspaceDir: params.placement.remoteWorkspaceDir,
    assertRunCurrent: params.assertRunCurrent,
    assertCurrent: () => {
      if (!params.placements.validateTurnClaim(params.turnClaim)) {
        throw new Error("Cloud attachment transfer lost its turn claim");
      }
    },
  });
  params.assertRunCurrent?.();
  params.placements.markWorkspaceResultPending(params.turnClaim);
  params.onHandoff();
  let execution: Result<EmbeddedAgentRunResult, unknown>;
  let executionActive = true;
  const originalPrompt = params.turn.prompt;
  const originalTranscriptPrompt = params.turn.transcriptPrompt;
  let computer: PreparedWorkerComputer | undefined;
  let skillResources: Awaited<ReturnType<typeof transferSkillResources>>;
  try {
    skillResources = await transferSkillResources({
      snapshot: params.turn.skillsSnapshot,
      explicitSelections: params.turn.explicitSkillSelections,
      tunnel,
      remoteWorkspaceDir: params.placement.remoteWorkspaceDir,
      signal: params.turn.abortSignal,
      assertRunCurrent: params.assertRunCurrent,
      assertCurrent: () => {
        const current = params.environments.get(environment.environmentId);
        if (
          !params.placements.validateTurnClaim(params.turnClaim) ||
          current?.state !== "attached" ||
          current.ownerEpoch !== environment.ownerEpoch ||
          current.leaseId !== environment.leaseId
        ) {
          throw new Error("Skill transfer lost its exact placement authority.");
        }
      },
    });
    params.assertRunCurrent?.();
    computer = await params.environments.prepareComputer?.(params.turnClaim);
    params.assertRunCurrent?.();
    const sandboxToolPolicy = resolveSandboxToolPolicyForAgent(
      params.turn.config,
      params.placement.agentId,
      {
        containedToolNames: computer ? ["computer"] : [],
      },
    );
    if (attachmentNote) {
      params.turn.transcriptPrompt ??= originalPrompt;
      params.turn.prompt = `${originalPrompt}\n\n${attachmentNote}`;
    }
    const result = await withPluginRuntimeGatewayRequestScope(
      {
        isWebchatConnect: () => false,
        ...getPluginRuntimeGatewayRequestScope(),
        assertNodeExecutionCurrent: (request) => {
          params.assertRunCurrent?.();
          const placement = params.placements.get(params.placement.sessionId);
          const currentEnvironment = params.environments.get(environment.environmentId);
          if (
            !executionActive ||
            params.turn.abortSignal?.aborted ||
            !params.placements.validateTurnClaim(params.turnClaim) ||
            request.runId !== params.turnClaim.runId ||
            request.agentId !== params.placement.agentId ||
            request.workspace.sessionId !== params.placement.sessionId ||
            request.workspace.sessionKey !== params.placement.sessionKey ||
            request.workspace.environmentId !== params.placement.environmentId ||
            request.workspace.ownerEpoch !== params.placement.activeOwnerEpoch ||
            request.workspace.workspaceDir !== params.placement.remoteWorkspaceDir ||
            placement?.state !== "active" ||
            placement.executionMode !== "remote-exec" ||
            placement.generation !== params.turnClaim.placementGeneration ||
            placement.sessionKey !== params.placement.sessionKey ||
            placement.agentId !== params.placement.agentId ||
            placement.environmentId !== params.placement.environmentId ||
            placement.activeOwnerEpoch !== params.placement.activeOwnerEpoch ||
            placement.remoteWorkspaceDir !== params.placement.remoteWorkspaceDir ||
            currentEnvironment?.state !== "attached" ||
            currentEnvironment.ownerEpoch !== environment.ownerEpoch ||
            currentEnvironment.leaseId !== environment.leaseId ||
            currentEnvironment.nodeDeviceId !== environment.nodeDeviceId ||
            currentEnvironment.nodeDeviceId !== request.nodeId ||
            currentEnvironment.attachedSessionIds.length !== 1 ||
            currentEnvironment.attachedSessionIds[0] !== params.placement.sessionId
          ) {
            throw new Error("node execution placement authority is no longer current");
          }
        },
      },
      () =>
        withSessionPlacementComputer(
          {
            runId: params.turnClaim.runId,
            agentId: params.placement.agentId,
            isActive: () => executionActive,
            sandboxToolPolicy: computer ? sandboxToolPolicy : undefined,
            bind: (run) => (computer ? computer.bind(run) : null),
          },
          () =>
            skillResources
              ? withSessionSkillResources(skillResources, params.runLocal)
              : params.runLocal(),
        ),
    );
    execution = { ok: true, value: result };
  } catch (error) {
    execution = { ok: false, error };
  } finally {
    // Execution admission ends before artifact cleanup; placement still owns teardown.
    executionActive = false;
    params.turn.prompt = originalPrompt;
    params.turn.transcriptPrompt = originalTranscriptPrompt;
  }
  try {
    await skillResources?.cleanup();
  } catch (error) {
    // Security-sensitive cleanup remains a rejecting boundary, not an advisory result.
    const primary = execution.ok ? error : execution.error;
    const diagnostic = execution.ok
      ? undefined
      : `Skill resource cleanup also failed: ${workspaceError(error)}`;
    execution = { ok: false, error: retainRemoteExecCleanupFailure(primary, diagnostic) };
  }
  try {
    await computer?.close("turn-complete");
  } catch (error) {
    const diagnostic = `Computer cleanup also failed: ${workspaceError(error)}`;
    execution = execution.ok
      ? { ok: true, value: appendAgentRunFailure(execution.value, diagnostic) }
      : { ok: false, error: retainRemoteExecCleanupFailure(execution.error, diagnostic) };
  }
  const workspaceConflict = await reconcileWorkspaceAfterTurn({
    placement: params.placement,
    placements: params.placements,
    turnClaim: params.turnClaim,
    workspaceOperations: params.workspaceOperations,
    workspace: params.workspace,
    transcriptTarget,
    tunnel,
    ...(params.prepareAcceptedWorkspacePublication
      ? { prepareAcceptedWorkspacePublication: params.prepareAcceptedWorkspacePublication }
      : {}),
    ...(params.publishAcceptedWorkspace
      ? { publishAcceptedWorkspace: params.publishAcceptedWorkspace }
      : {}),
  }).catch((reconciliationError: unknown) => {
    const currentEnvironment = params.environments.get(params.placement.environmentId);
    if (
      environment.nodeDeviceId &&
      currentEnvironment?.state === "attached" &&
      currentEnvironment.providerId === environment.providerId &&
      currentEnvironment.environmentId === environment.environmentId &&
      currentEnvironment.ownerEpoch === environment.ownerEpoch &&
      currentEnvironment.nodeDeviceId === environment.nodeDeviceId &&
      currentEnvironment.attachedSessionIds.length === 1 &&
      currentEnvironment.attachedSessionIds[0] === params.placement.sessionId &&
      reconciliationError instanceof WorkerWorkspaceReconciliationError &&
      reconciliationError.cause instanceof WorkerTunnelOwnerDisconnectedError
    ) {
      // Offline nodes keep their exact lease; the next turn reconciles its dirty workspace.
      params.placements.cancelWorkspaceResultAndReleaseTurn(params.turnClaim, {
        reason: "node-disconnect",
      });
    }
    if (!execution.ok) {
      throw remoteExecWorkspaceFailure(execution.error, reconciliationError);
    }
    if (execution.value.meta.error) {
      throw remoteExecWorkspaceFailure(execution.value.meta.error.message, reconciliationError);
    }
    throw reconciliationError;
  });
  if (!execution.ok) {
    throw execution.error instanceof Error
      ? execution.error
      : new Error(formatErrorMessage(execution.error));
  }
  const result = execution.value;
  if (!workspaceConflict) {
    return result;
  }
  const resultText = result.payloads
    ?.flatMap((payload) => (payload.text ? [payload.text] : []))
    .join("\n\n");
  await Promise.resolve(
    params.turn.onAgentEvent?.({
      stream: "assistant",
      data: {
        text: resultText
          ? `${resultText}\n\n${workspaceConflict.summary}`
          : workspaceConflict.summary,
        delta: `${resultText ? "\n\n" : ""}${workspaceConflict.summary}`,
      },
    }),
  ).catch(() => undefined);
  return appendWorkspaceConflict(result, workspaceConflict);
}
