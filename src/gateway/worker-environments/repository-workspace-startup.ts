import fs from "node:fs/promises";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { hasErrnoCode } from "../../infra/errors.js";
import {
  getSessionRepositoryWorkspaceStore,
  repositoryWorkspaceArtifactsAreEphemeral,
} from "../../state/session-repository-workspaces.js";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import { recordWorkerPlacementAwait } from "./placement-diagnostics.js";
import {
  stageSessionRepositoryCheckpoint,
  withSessionRepositoryCheckpoint,
} from "./session-repository-checkpoints.js";
import type {
  PreparedRepositoryWorkspace,
  WorkerTunnelHandle,
  WorkerWorkspaceSyncRequest,
} from "./tunnel-contract.js";
import { prepareWorkerRepositoryGitHubIdentity } from "./worker-github-binding.js";

/** Prepare source on the worker and durably accept its initial state before activation. */
export async function syncSessionRepositoryWorkspace(params: {
  repository: SessionRepositoryWorkspaceRecord;
  tunnel: WorkerTunnelHandle;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  generation: number;
  gitAuthor?: { name?: string; email?: string };
  runSetupScript?: boolean;
  recovery?: true;
  recoveryHeadCommit?: string;
  preparedRepository?: PreparedRepositoryWorkspace;
  assertCurrent: () => void;
  signal?: AbortSignal;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  readNativeCredential?: import("../../agents/github-credential-reader.js").GitHubCredentialReader;
  /** Node's typed effect gate excludes all repository operations until publication. */
  repositoryOperationsBlocked?: boolean;
}) {
  const store = getSessionRepositoryWorkspaceStore();
  let repository = params.repository;
  let reconstructingAcceptedBase = false;
  const syncFacts = {
    generation: params.generation,
    environmentId: params.tunnel.environmentId,
    ownerEpoch: params.tunnel.ownerEpoch,
  };
  await recordWorkerPlacementAwait(
    params.sessionId,
    "repository_checkpoint_source",
    async () => {
      if (repository.checkpointRef && repositoryWorkspaceArtifactsAreEphemeral()) {
        try {
          await fs.access(store.artifactPath(repository.workspaceId));
        } catch (error) {
          if (!hasErrnoCode(error, "ENOENT")) {
            throw error;
          }
          params.assertCurrent();
          if (
            !repository.baseCommit ||
            !repository.baseManifestHash ||
            repository.manifestHash !== repository.baseManifestHash
          ) {
            throw new Error(
              "Accepted repository checkpoint is unavailable; recover its retained changes before dispatch.",
              { cause: error },
            );
          }
          // Reconstruct only the attested unchanged base. Keep the durable accepted
          // pointer until replacement publication succeeds under its original revision.
          reconstructingAcceptedBase = true;
          repository = { ...repository, checkpointRef: null, manifestHash: null };
        }
      }
    },
    syncFacts,
    "placement",
  );
  const prepared = params.preparedRepository;
  const preparedRefMode = prepared
    ? !repository.baseCommit
      ? params.recovery
        ? "recover"
        : "fetch"
      : repository.baseCommit !== prepared.baseCommit
        ? "fetch"
        : undefined
    : undefined;
  if (
    prepared &&
    repository.baseCommit &&
    prepared.baseCommit !== repository.baseCommit &&
    !params.recovery
  ) {
    throw new Error("Prepared repository does not match the pinned session commit");
  }
  if (
    prepared &&
    repository.baseManifestHash &&
    prepared.sourceManifestRef !== repository.baseManifestHash &&
    !params.recovery
  ) {
    throw new Error("Prepared repository does not match the pinned source manifest");
  }
  if (
    params.recovery &&
    !reconstructingAcceptedBase &&
    !prepared &&
    !repository.checkpointRef &&
    repository.runSetupScript
  ) {
    throw new Error(
      "Repository setup was interrupted before its first checkpoint. Retry dispatch with an administrator to authorize setup again.",
    );
  }
  if (
    !prepared &&
    !repository.checkpointRef &&
    repository.runSetupScript &&
    params.runSetupScript !== true
  ) {
    throw new Error(
      "Repository setup requires administrator authorization; retry dispatch as an administrator.",
    );
  }
  params.assertCurrent();
  const needsCloneCredential = !prepared || preparedRefMode === "fetch";
  const github = !needsCloneCredential
    ? undefined
    : await recordWorkerPlacementAwait(
        params.sessionId,
        "repository_identity",
        () =>
          prepareWorkerRepositoryGitHubIdentity({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            agentId: params.agentId,
            assertCurrent: params.assertCurrent,
            signal: params.signal,
            operatorAuthority: params.operatorAuthority,
            readNativeCredential: params.readNativeCredential,
          }),
        syncFacts,
        "placement",
      );
  const assertCurrent = () => {
    params.assertCurrent();
    github?.assertSelected();
  };
  assertCurrent();
  const source: Extract<WorkerWorkspaceSyncRequest["source"], { kind: "repository" }> = {
    kind: "repository",
    url: repository.url,
    ref: repository.requestedRef ?? undefined,
    branch: repository.branch,
    // A new From-ref session resolves its selected head on the bound worker.
    // The prepared commit attests the starting workspace, not the mutable ref.
    baseCommit: repository.baseCommit ?? undefined,
    ...(params.recoveryHeadCommit ? { recoveryHeadCommit: params.recoveryHeadCommit } : {}),
    ...(prepared ? { prepared } : {}),
    ...(preparedRefMode ? { preparedRefMode } : {}),
    runSetupScript:
      !prepared &&
      !repository.checkpointRef &&
      repository.runSetupScript &&
      params.runSetupScript === true,
    ...(github?.token ? { gitToken: github.token } : {}),
  };
  const sync = async (checkpoint?: typeof source.checkpoint) => {
    await github?.revalidate();
    assertCurrent();
    return await recordWorkerPlacementAwait(
      params.sessionId,
      "repository_sync",
      () =>
        params.tunnel.syncWorkspace({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          generation: params.generation,
          gitAuthor: params.gitAuthor,
          source: { ...source, ...(checkpoint ? { checkpoint } : {}) },
          authorize: assertCurrent,
        }),
      syncFacts,
      "placement",
    );
  };
  const synced = repository.checkpointRef
    ? await recordWorkerPlacementAwait(
        params.sessionId,
        "repository_checkpoint_load",
        () =>
          withSessionRepositoryCheckpoint(
            { workspaceId: repository.workspaceId, includePublication: true },
            sync,
          ),
        syncFacts,
        "placement",
      )
    : await sync();
  assertCurrent();
  const validated = await recordWorkerPlacementAwait(
    params.sessionId,
    "repository_validation",
    async () => {
      if (synced.mode !== "repository") {
        throw new Error("Repository preparation did not return a repository workspace");
      }
      if (repository.baseCommit && repository.baseCommit !== synced.baseCommit) {
        throw new Error("Repository preparation changed the admitted head");
      }
      if (
        prepared &&
        (synced.remoteWorkspaceDir !== prepared.workspaceDir ||
          (repository.baseCommit === prepared.baseCommit &&
            (synced.baseCommit !== prepared.baseCommit ||
              synced.baseManifestRef !== prepared.sourceManifestRef)))
      ) {
        throw new Error("Repository preparation changed its attested prepared workspace");
      }
      if (!repository.baseCommit || !repository.baseManifestHash) {
        repository = await store.bindBase({
          workspaceId: repository.workspaceId,
          expectedRevision: repository.revision,
          baseCommit: synced.baseCommit,
          baseManifestHash: synced.baseManifestRef,
          assertCurrent,
        });
        assertCurrent();
      } else if (
        repository.baseCommit !== synced.baseCommit ||
        repository.baseManifestHash !== synced.baseManifestRef
      ) {
        throw new Error("Repository preparation changed the pinned source baseline");
      }
      if (repository.checkpointRef) {
        if (synced.manifestRef !== repository.manifestHash) {
          throw new Error("Repository preparation did not restore the accepted checkpoint");
        }
      }
      return synced;
    },
    syncFacts,
    "placement",
  );
  assertCurrent();
  if (repository.checkpointRef) {
    return validated;
  }
  return await recordWorkerPlacementAwait(
    params.sessionId,
    "checkpoint_accept",
    async () => {
      const quiescence = params.repositoryOperationsBlocked
        ? undefined
        : await params.tunnel.quiesceWorkspace(validated.remoteWorkspaceDir);
      let reconciliation: Awaited<ReturnType<WorkerTunnelHandle["reconcileWorkspace"]>> | undefined;
      try {
        assertCurrent();
        reconciliation = await params.tunnel.reconcileWorkspace({
          remoteWorkspaceDir: validated.remoteWorkspaceDir,
          baseManifestRef: validated.baseManifestRef,
          source: {
            kind: "repository",
            authorize: assertCurrent,
            referenceManifestRef: validated.manifestRef,
            prepareCheckpoint: (payload) =>
              stageSessionRepositoryCheckpoint({
                ...payload,
                workspaceId: repository.workspaceId,
                expectedRevision: repository.revision,
                assertCurrent,
              }),
          },
        });
        await quiescence?.assertActive();
        await reconciliation.verifyStable();
        await reconciliation.verifyLocalStable();
        assertCurrent();
        await reconciliation.publishStagedResult();
        assertCurrent();
        return { ...validated, manifestRef: reconciliation.manifestRef };
      } finally {
        try {
          await reconciliation?.discardPreparedStagedResult();
        } finally {
          await quiescence?.resume();
        }
      }
    },
    { generation: params.generation },
    "dispatch",
  );
}
