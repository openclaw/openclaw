import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import { recordWorkerPlacementStage } from "./placement-diagnostics.js";
import type {
  WorkerDispatchEnvironmentService,
  WorkerDispatchPlacementStore,
} from "./placement-dispatch-failure.js";
import {
  reportPlacementTransition,
  type WorkerSessionPlacementRecord,
} from "./placement-record.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";

export function canPrepareRepositoryConcurrently(
  request: WorkerPlacementDispatchRequest,
  workspace: WorkerSessionWorkspace,
): boolean {
  return (
    process.env.FACTORY_AUTH_MODE === "github" &&
    workspace.kind === "repository" &&
    request.executionMode === "remote-exec" &&
    !request.deviceId &&
    request.devicePlacement?.requiredNodeCommands.some(
      (command) =>
        command.startsWith("codex.app-server.") || command === "codex.exec-server.stdio.v1",
    ) === true &&
    Boolean(request.operatorAuthority?.retain && request.trackRepositoryPreparation)
  );
}

export function needsColdRepositoryRevalidation(
  request: WorkerPlacementDispatchRequest,
  workspace: WorkerSessionWorkspace,
  prepared: unknown,
  asynchronousRepository: boolean,
) {
  return (
    process.env.FACTORY_AUTH_MODE === "github" &&
    workspace.kind === "repository" &&
    !request.deviceId &&
    !prepared &&
    !asynchronousRepository
  );
}

/** One canonical preparation keeps original source custody after conversational admission. */
export async function prepareActiveRepository(params: {
  request: WorkerPlacementDispatchRequest;
  placement: Extract<WorkerSessionPlacementRecord, { state: "active" }>;
  repository: SessionRepositoryWorkspaceRecord;
  environments: WorkerDispatchEnvironmentService;
  placements: WorkerDispatchPlacementStore;
  tunnel: WorkerTunnelHandle;
  assertCurrent(this: void): void;
  assertCleanupCurrent(this: void): void;
  sync(
    repository: SessionRepositoryWorkspaceRecord,
  ): Promise<import("./tunnel-contract.js").WorkerWorkspaceSyncResult>;
  releaseAuthority(): void;
  onTransition?: (placement: WorkerSessionPlacementRecord) => void;
}) {
  const { request, placement, repository, assertCurrent } = params;
  const owner = {
    sessionId: request.sessionId,
    sessionKey: request.sessionKey,
    agentId: request.agentId,
    environmentId: placement.environmentId,
    ownerEpoch: placement.activeOwnerEpoch,
    expectedGeneration: placement.generation,
  };
  let preparationPhase:
    | "intent"
    | "source_validation"
    | "workspace_sync"
    | "post_sync_validation"
    | "ready_publication" = "intent";
  try {
    assertCurrent();
    const intent = await params.environments.prepareProjectIntent(request.profileId, {
      machineClass: request.machineClass,
      executionMode: request.executionMode,
      inherited: request.inheritedProfile,
      repository: {
        agentId: request.agentId,
        url: repository.url,
        ref: repository.requestedRef ?? undefined,
        baseCommit: repository.baseCommit ?? undefined,
      },
      signal: request.repositoryPreparationSignal,
      os: request.os,
      runSetupScript: request.runSetupScript,
      setupAuthorized: request.runSetupScript !== undefined,
      readNativeCredential:
        request.operatorAuthority!.createFactoryGitHubDispatchCredentialReader?.({
          ...request,
          repositoryUrl: repository.url,
          assertCurrent,
        }),
    });
    assertCurrent();
    preparationPhase = "source_validation";
    params.environments.assertPreparedIntentCurrent(request.profileId, intent);
    await params.environments.revalidatePreparedIntentRepository(
      request.profileId,
      intent,
      request.repositoryPreparationSignal,
    );
    assertCurrent();
    const admitted = readWorkerProjectSnapshot(intent.profileSnapshot.project);
    if (
      !admitted ||
      !("source" in admitted) ||
      admitted.source.url !== repository.url ||
      (repository.baseCommit && repository.baseCommit !== admitted.baseCommit)
    ) {
      throw new Error("Repository admission changed its exact source or pinned head");
    }
    preparationPhase = "workspace_sync";
    const result = await params.sync({ ...repository, baseCommit: admitted.baseCommit });
    assertCurrent();
    if (result.mode !== "repository") {
      throw new Error("Repository synchronization returned no branch proof");
    }
    preparationPhase = "post_sync_validation";
    await params.environments.revalidatePreparedIntentRepository(
      request.profileId,
      intent,
      request.repositoryPreparationSignal,
    );
    assertCurrent();
    preparationPhase = "ready_publication";
    const ready = await params.placements.settleRepository(
      { ...owner, status: "ready", manifestRef: result.manifestRef },
      assertCurrent,
    );
    await params.tunnel.settleRepositoryWorkspace!("ready", result.baseCommit);
    reportPlacementTransition(params.onTransition, ready);
  } catch (error) {
    recordWorkerPlacementStage(request.sessionId, "workspace_sync_failed", {
      generation: placement.generation,
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
      diagnosticCode: "operation_failed",
      preparationPhase,
      preparationSignalAborted: request.repositoryPreparationSignal?.aborted ?? false,
      operatorSignalAborted: request.operatorAuthority?.signal?.aborted ?? false,
      error,
    });
    try {
      params.assertCleanupCurrent();
      // Node failure wakes blocked commands immediately. Publish durable placement
      // custody first so their terminal result cannot race its pending publication.
      const failed = await params.placements.settleRepository(
        { ...owner, status: "failed" },
        params.assertCleanupCurrent,
      );
      reportPlacementTransition(params.onTransition, failed);
      try {
        params.assertCleanupCurrent();
        await params.tunnel.settleRepositoryWorkspace!("failed");
      } catch (publicationError) {
        params.assertCleanupCurrent();
        await params.environments.stopTunnel(placement.environmentId, placement.activeOwnerEpoch);
        throw publicationError;
      }
    } catch (settlementError) {
      recordWorkerPlacementStage(request.sessionId, "workspace_sync_failed", {
        generation: placement.generation,
        environmentId: placement.environmentId,
        ownerEpoch: placement.activeOwnerEpoch,
        diagnosticCode: "operation_failed",
        error: settlementError,
        certainty: "unknown",
      });
    }
    throw error;
  } finally {
    params.releaseAuthority();
  }
}
