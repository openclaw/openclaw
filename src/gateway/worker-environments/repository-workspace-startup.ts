import type { GitHubCredentialReader } from "../../agents/github-credential-reader.js";
import { createRepositoryCheckoutTransfer } from "../../plugins/repository-checkout-transfer.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import type { RepositorySources } from "../repository-sources.js";
import {
  stageSessionRepositoryCheckpoint,
  withSessionRepositoryCheckpoint,
} from "./session-repository-checkpoints.js";
import type {
  PreparedRepositoryWorkspace,
  WorkerTunnelHandle,
  WorkerWorkspaceSyncRequest,
} from "./tunnel-contract.js";

/** Prepare source on the worker and durably accept its initial state before activation. */
export async function syncSessionRepositoryWorkspace(params: {
  repository: SessionRepositoryWorkspaceRecord;
  repositorySourceId?: string;
  getRepositorySources?: () => RepositorySources;
  tunnel: WorkerTunnelHandle;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  generation: number;
  gitAuthor?: { name?: string; email?: string };
  runSetupScript?: boolean;
  readNativeCredential?: GitHubCredentialReader;
  retainCredentialCleanup?: (revoke: () => Promise<void>) => void;
  preparedRepository?: PreparedRepositoryWorkspace;
  assertCurrent: () => void;
  markPhase?: (phase: string) => void;
}) {
  const store = getSessionRepositoryWorkspaceStore();
  const assertCurrent = params.assertCurrent;
  let repository = params.repository;
  if (repository.diskAuthority) {
    throw new Error(
      "Repository disk is already authoritative; resume the original resource instead of restoring a mirror",
    );
  }
  const prepared = params.preparedRepository;
  if (prepared && repository.baseCommit && prepared.baseCommit !== repository.baseCommit) {
    throw new Error("Prepared repository does not match the pinned session commit");
  }
  if (
    prepared &&
    repository.baseManifestHash &&
    prepared.sourceManifestRef !== repository.baseManifestHash
  ) {
    throw new Error("Prepared repository does not match the pinned source manifest");
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
  const repositorySource = prepared
    ? undefined
    : params.getRepositorySources?.().resolve(repository.url, params.repositorySourceId);
  if (!prepared && !repositorySource) {
    throw new Error("Repository source service is unavailable; retry after Gateway startup.");
  }
  const source: Extract<WorkerWorkspaceSyncRequest["source"], { kind: "repository" }> = {
    kind: "repository",
    url: repository.url,
    ref: repository.requestedRef ?? undefined,
    branch: repository.branch,
    baseCommit: repository.baseCommit ?? prepared?.baseCommit,
    ...(prepared ? { prepared } : {}),
    runSetupScript:
      !prepared &&
      !repository.checkpointRef &&
      repository.runSetupScript &&
      params.runSetupScript === true,
  };
  const sync = async (checkpoint?: typeof source.checkpoint) => {
    params.assertCurrent();
    const request = {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      generation: params.generation,
      gitAuthor: params.gitAuthor,
      source: { ...source, ...(checkpoint ? { checkpoint } : {}) },
      authorize: params.assertCurrent,
    };
    if (!repositorySource) {
      return await params.tunnel.syncWorkspace(request);
    }
    const bound = createRepositoryCheckoutTransfer(params.tunnel, request, params.assertCurrent);
    await repositorySource.checkoutWorker({
      readCredential: params.readNativeCredential,
      retainCredentialCleanup: params.retainCredentialCleanup,
      agentId: params.agentId,
      transfer: bound.transfer,
      assertCurrent: params.assertCurrent,
    });
    params.assertCurrent();
    return bound.result();
  };
  params.markPhase?.("repositorySync");
  const synced = repository.checkpointRef
    ? await withSessionRepositoryCheckpoint({ workspaceId: repository.workspaceId }, sync)
    : await sync();
  assertCurrent();
  if (synced.mode !== "repository") {
    throw new Error("Repository preparation did not return a repository workspace");
  }
  if (
    prepared &&
    (synced.baseCommit !== prepared.baseCommit ||
      synced.baseManifestRef !== prepared.sourceManifestRef ||
      synced.remoteWorkspaceDir !== prepared.workspaceDir)
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
    return synced;
  }
  params.markPhase?.("repositoryQuiesce");
  const quiescence = await params.tunnel.quiesceWorkspace(synced.remoteWorkspaceDir);
  let reconciliation: Awaited<ReturnType<WorkerTunnelHandle["reconcileWorkspace"]>> | undefined;
  try {
    assertCurrent();
    params.markPhase?.("repositoryReconcile");
    reconciliation = await params.tunnel.reconcileWorkspace({
      remoteWorkspaceDir: synced.remoteWorkspaceDir,
      baseManifestRef: synced.baseManifestRef,
      source: {
        kind: "repository",
        markPhase: params.markPhase,
        authorize: assertCurrent,
        referenceManifestRef: synced.manifestRef,
        prepareCheckpoint: (payload) =>
          stageSessionRepositoryCheckpoint({
            ...payload,
            workspaceId: repository.workspaceId,
            expectedRevision: repository.revision,
            assertCurrent,
          }),
      },
    });
    params.markPhase?.("repositoryQuiescenceRenewal");
    await quiescence.assertActive();
    params.markPhase?.("repositoryVerification");
    await reconciliation.verifyStable();
    params.markPhase?.("repositoryLocalVerification");
    await reconciliation.verifyLocalStable();
    assertCurrent();
    params.markPhase?.("repositoryAcceptance");
    await reconciliation.publishStagedResult();
    assertCurrent();
    return { ...synced, manifestRef: reconciliation.manifestRef };
  } finally {
    params.markPhase?.("repositoryCleanup");
    try {
      await reconciliation?.discardPreparedStagedResult();
    } finally {
      await quiescence.resume();
    }
  }
}
