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
    request.devicePlacement?.requiredNodeCommands.some((command) =>
      command.startsWith("codex.app-server."),
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
    const result = await params.sync({ ...repository, baseCommit: admitted.baseCommit });
    assertCurrent();
    if (result.mode !== "repository") {
      throw new Error("Repository synchronization returned no branch proof");
    }
    await params.environments.revalidatePreparedIntentRepository(
      request.profileId,
      intent,
      request.repositoryPreparationSignal,
    );
    assertCurrent();
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
      error,
    });
    try {
      params.assertCleanupCurrent();
      const settled = await Promise.allSettled([
        params.tunnel.settleRepositoryWorkspace!("failed"),
        params.placements.settleRepository(
          { ...owner, status: "failed" },
          params.assertCleanupCurrent,
        ),
      ]);
      const placementOutcome = settled[1];
      if (placementOutcome.status === "rejected") {
        throw placementOutcome.reason;
      }
      const failed = placementOutcome.value;
      reportPlacementTransition(params.onTransition, failed);
      if (settled[0].status === "rejected") {
        params.assertCleanupCurrent();
        await params.environments.stopTunnel(placement.environmentId, placement.activeOwnerEpoch);
        throw settled[0].reason;
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
