import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import { readImageReserveProject } from "./image-reserve.js";
import { recordWorkerPlacementAwait } from "./placement-diagnostics.js";
import type { WorkerDispatchEnvironmentService } from "./placement-dispatch-failure.js";
import { readWorkerProjectPreparation } from "./preparation-identity.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import { syncSessionRepositoryWorkspace } from "./repository-workspace-startup.js";
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";

export function syncProvisionedWorkspace(params: {
  request: WorkerPlacementDispatchRequest;
  environment: Awaited<ReturnType<WorkerEnvironmentService["createWithRequest"]>>;
  environments: WorkerDispatchEnvironmentService;
  workspace: WorkerSessionWorkspace;
  tunnel: WorkerTunnelHandle;
  generation: number;
  ownerEpoch: number;
  repository?: SessionRepositoryWorkspaceRecord;
  gitAuthor?: { name?: string; email?: string };
  signal?: AbortSignal;
  recovery?: true;
  asynchronousRepository: boolean;
  assertCurrent(this: void): void;
}) {
  const { request, environments, tunnel, gitAuthor } = params;
  const repository = params.repository;
  const project = readWorkerProjectSnapshot(params.environment.profileSnapshot.project);
  const syncFacts = {
    generation: params.generation,
    environmentId: params.environment.environmentId,
    ownerEpoch: params.ownerEpoch,
  };
  return recordWorkerPlacementAwait(
    request.sessionId,
    "workspace_sync",
    async () => {
      const preparation = readWorkerProjectPreparation(params.environment.profileSnapshot.project);
      let preparedRepository: Parameters<
        typeof syncSessionRepositoryWorkspace
      >[0]["preparedRepository"];
      if (preparation && !readImageReserveProject(params.environment.profileSnapshot.project)) {
        if (project && "source" in project) {
          if (
            params.workspace.kind !== "repository" ||
            project.source.url !== params.workspace.repository.url
          ) {
            throw new Error("Prepared repository does not match this session's source");
          }
        }
        // Every command to a prepared workspace needs its session binding.
        // Reuse the checkout only when its immutable base matches or is unpinned.
        const prepared = await recordWorkerPlacementAwait(
          request.sessionId,
          "workspace_preparation",
          async () => {
            const boundWorkspace = await environments.bindPreparedWorkspace({
              environmentId: params.environment.environmentId,
              ownerEpoch: params.ownerEpoch,
              sessionId: request.sessionId,
              sessionKey: request.sessionKey,
              preparationKey: preparation.key,
              cacheKey: preparation.cacheKey,
              signal: params.signal,
              assertCurrent: params.assertCurrent,
            });
            params.assertCurrent();
            return boundWorkspace;
          },
          syncFacts,
          "dispatch",
        );
        if (project && "source" in project && params.workspace.kind === "repository") {
          if (
            !params.workspace.repository.baseCommit ||
            project.baseCommit === params.workspace.repository.baseCommit
          ) {
            preparedRepository = {
              baseCommit: project.baseCommit,
              workspaceDir: prepared.workspaceDir,
              sourceManifestRef: prepared.sourceManifestRef,
              preparedManifestRef: prepared.preparedManifestRef,
            };
          }
        }
      }
      const retainedSource = environments.readRecoveryHold?.(request.sessionId);
      const syncResult =
        params.workspace.kind === "repository"
          ? await syncSessionRepositoryWorkspace({
              repository: repository ?? params.workspace.repository,
              preparedRepository,
              tunnel,
              sessionId: request.sessionId,
              sessionKey: request.sessionKey,
              agentId: request.agentId,
              generation: params.generation,
              gitAuthor,
              signal: params.signal,
              operatorAuthority: request.operatorAuthority,
              readNativeCredential: params.asynchronousRepository
                ? request.operatorAuthority!.createFactoryGitHubDispatchCredentialReader?.({
                    ...request,
                    repositoryUrl: params.workspace.repository.url,
                    assertCurrent: params.assertCurrent,
                  })
                : request.readNativeCredential,
              runSetupScript: request.runSetupScript,
              recovery: params.recovery,
              repositoryOperationsBlocked: params.asynchronousRepository,
              recoveryHeadCommit:
                retainedSource?.checkpointRef === params.workspace.repository.checkpointRef
                  ? retainedSource?.remoteHeadCommit
                  : undefined,
              assertCurrent: params.assertCurrent,
            })
          : await tunnel.syncWorkspace({
              source: {
                kind: "local",
                path: params.workspace.path,
                ...(project ? { projectKey: project.key } : {}),
              },
              sessionId: request.sessionId,
              sessionKey: request.sessionKey,
              generation: params.generation,
              ...(gitAuthor ? { gitAuthor } : {}),
              authorize: params.assertCurrent,
            });
      params.assertCurrent();
      return syncResult;
    },
    syncFacts,
    "placement",
  );
}
