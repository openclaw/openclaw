import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveGitHubHost } from "../../agents/github-host-runtime.js";
import { getRuntimeConfig } from "../../config/config.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { parseGitHubRemoteUrl } from "../github-remote.js";
import { prepareRepositoryGitHubPublicationBranch } from "../github-repository-publication-store.js";
import type { WorkerPlacementDispatchOptions } from "./placement-dispatch.types.js";
import { prepareRepositoryRecoveryCheckout } from "./repository-git-pack.js";
import { prepareRepositoryWorkerProjectSource } from "./repository-project-admission.js";
import type { PrepareRetainedRecoveryCheckpoint } from "./retained-worker-recovery.js";
import {
  withSessionRepositoryCheckpoint,
  stageSessionRepositoryCheckpoint,
  readSessionRepositoryArtifacts,
} from "./session-repository-checkpoints.js";
import { prepareWorkerRepositoryGitHubIdentity } from "./worker-github-binding.js";
import { captureWorkspaceSnapshot } from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { applyStagedWorkerWorkspace } from "./workspace-reconcile-apply.js";

/** The explicit ephemeral policy keeps the recorded repository/branch and drops only worker files. */
export const prepareRepositoryRefRecovery: NonNullable<
  WorkerPlacementDispatchOptions["prepareRepositoryRefRecovery"]
> = async (identity) => {
  identity.assertCurrent();
  const store = getSessionRepositoryWorkspaceStore();
  const prepared = await store.find({ agentId: identity.agentId, sessionKey: identity.sessionKey });
  identity.assertCurrent();
  if (!prepared) {
    throw new Error("Ephemeral worker recovery requires the existing repository workspace");
  }
  const remote = parseGitHubRemoteUrl(prepared.url, resolveGitHubHost());
  if (!remote) {
    throw new Error("Recovery requires a canonical GitHub repository");
  }
  const publication = await prepareRepositoryGitHubPublicationBranch(
    {
      workspaceId: prepared.workspaceId,
      branch: prepared.branch,
      pushRepository: `${remote.owner}/${remote.repo}`,
    },
    identity,
  );
  try {
    const originalPublication = publication.current();
    const [prefix, generatedId, extra] = prepared.branch.split("/");
    // Creation generates this branch from the workspace's own UUID. A receipt of
    // any publication attempt keeps recovery on the remote-branch path.
    const unpublishedGeneratedBranch =
      !originalPublication.attempted &&
      !originalPublication.head &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(prefix ?? "") &&
      generatedId === prepared.workspaceId &&
      extra === undefined &&
      prepared.requestedRef !== prepared.branch &&
      prepared.requestedRef !== `refs/heads/${prepared.branch}`;
    const unpublishedBase = unpublishedGeneratedBranch ? prepared.baseCommit : null;
    const initialUnpublished =
      unpublishedGeneratedBranch &&
      prepared.revision === 0 &&
      prepared.baseCommit === null &&
      prepared.baseManifestHash === null &&
      prepared.checkpointRef === null &&
      prepared.manifestHash === null;
    const assertCurrent = () => {
      identity.signal?.throwIfAborted();
      identity.assertCurrent();
      const current = publication.current();
      if (
        current.unsettled ||
        current.attempted !== originalPublication.attempted ||
        current.head?.pushed_head_commit !== originalPublication.head?.pushed_head_commit
      ) {
        throw new Error("Repository publication must settle before ephemeral worker recovery");
      }
    };
    assertCurrent();
    const source = await prepareRepositoryWorkerProjectSource({
      namespace: prepared.workspaceId,
      getConfig: getRuntimeConfig,
      assertCurrent,
      signal: identity.signal,
      readNativeCredential: identity.readNativeCredential,
      repository: {
        agentId: identity.agentId,
        url: prepared.url,
        ref: initialUnpublished ? (prepared.requestedRef ?? undefined) : prepared.branch,
        ...(unpublishedBase ? { baseCommit: unpublishedBase } : {}),
        ...(initialUnpublished ? {} : { currentBranch: true as const }),
      },
    });
    assertCurrent();
    await source.revalidate(identity.signal);
    assertCurrent();
    if (!initialUnpublished && source.branch !== prepared.branch) {
      throw new Error("Ephemeral worker recovery repository branch changed");
    }
    await store.advanceToPublishedHead({
      workspaceId: prepared.workspaceId,
      expectedRevision: prepared.revision,
      branch: prepared.branch,
      headCommit: source.project.baseCommit,
      preserveRequestedRef: true,
      assertCurrent: () => {
        assertCurrent();
        source.assertCurrent();
      },
    });
    assertCurrent();
  } finally {
    publication.release();
  }
};

/** Disposal preserves verified accepted bytes without authorizing the old executor or remote. */
export const prepareAcceptedRepositoryDisposal: PrepareRetainedRecoveryCheckpoint = async (
  identity,
  workspace,
) => {
  identity.assertCurrent();
  const repository = workspace.repository;
  const snapshot = await readSessionRepositoryArtifacts({
    workspaceId: repository.workspaceId,
    assertCurrent: identity.assertCurrent,
  });
  identity.assertCurrent();
  if (!repository.checkpointRef || snapshot.currentManifestRef !== repository.manifestHash) {
    throw new Error("Failed worker disposal lost its accepted checkpoint");
  }
  return {
    workspaceId: repository.workspaceId,
    expectedWorkspaceRevision: repository.revision,
    previousCheckpointRef: repository.checkpointRef,
    checkpointRef: repository.checkpointRef,
    manifestHash: snapshot.currentManifestRef,
  };
};

/** Reconcile accepted bytes on an isolated checkout; neither the remote nor old disk is written. */
export const prepareRetainedRepositoryCheckpoint: PrepareRetainedRecoveryCheckpoint = async (
  identity,
  workspace,
) => {
  const repository = workspace.repository;
  if (!repository.baseCommit || !repository.baseManifestHash || !repository.checkpointRef) {
    throw new Error("Failed worker has no accepted repository checkpoint");
  }
  const previousCheckpointRef = repository.checkpointRef;
  const remote = parseGitHubRemoteUrl(repository.url, resolveGitHubHost());
  if (!remote) {
    throw new Error("Recovery requires a canonical GitHub repository");
  }
  const publication = await prepareRepositoryGitHubPublicationBranch(
    {
      workspaceId: repository.workspaceId,
      branch: repository.branch,
      pushRepository: `${remote.owner}/${remote.repo}`,
    },
    identity,
  );
  try {
    const initialPublication = publication.current();
    const check = () => {
      identity.signal?.throwIfAborted();
      identity.assertCurrent();
      const current = publication.current();
      if (
        current.unsettled ||
        current.head?.pushed_head_commit !== initialPublication.head?.pushed_head_commit
      ) {
        throw new Error("Repository publication must settle before failed-worker recovery");
      }
    };
    check();
    const github = await prepareWorkerRepositoryGitHubIdentity({
      ...identity,
      assertCurrent: check,
    });
    const assertCurrent = () => {
      check();
      github.assertSelected();
    };
    assertCurrent();
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-retained-recovery-"));
    try {
      await github.revalidate();
      assertCurrent();
      const { root, remoteHeadCommit, verifyRemote } = await prepareRepositoryRecoveryCheckout({
        url: repository.url,
        baseCommit: repository.baseCommit,
        branch: repository.branch,
        requestedRef: repository.requestedRef,
        temporaryRoot: temporary,
        token: github?.token,
        signal: identity.signal ?? new AbortController().signal,
        assertCurrent,
      });
      const remoteSnapshot = await captureWorkspaceSnapshot({
        root,
        baseCommit: repository.baseCommit,
        signal: identity.signal,
      });
      return await withSessionRepositoryCheckpoint(
        { workspaceId: repository.workspaceId },
        async (snapshot) => {
          assertCurrent();
          const applied = await applyStagedWorkerWorkspace({
            ...snapshot,
            root,
            assertCurrent,
            acceptance: { kind: "reconcile" },
            journal: {
              load: async () => undefined,
              begin: async () => assertCurrent(),
              commit: async () => assertCurrent(),
              abort: async () => check(),
            },
          });
          await applied.verifyLocalStable();
          assertCurrent();
          const current = await captureWorkspaceSnapshot({
            root,
            baseCommit: repository.baseCommit,
            includePaths: new Set(
              [...remoteSnapshot.manifest.entries, ...snapshot.current.entries].map(
                (entry) => entry.path,
              ),
            ),
            signal: identity.signal,
          });
          await github.revalidate();
          await verifyRemote();
          assertCurrent();
          const prepared = await stageSessionRepositoryCheckpoint({
            workspaceId: repository.workspaceId,
            expectedRevision: repository.revision,
            checkpointRef: `refs/openclaw/worker-results/retained-${randomUUID()}`,
            stagingRoot: root,
            baseManifestRaw: snapshot.baseManifestRaw,
            baseManifestRef: snapshot.baseManifestRef,
            currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
            currentManifestRef: current.manifestRef,
            assertCurrent,
          });
          try {
            await prepared.verify();
            assertCurrent();
            await prepared.publishArtifacts();
            assertCurrent();
            return {
              workspaceId: repository.workspaceId,
              expectedWorkspaceRevision: repository.revision,
              previousCheckpointRef,
              checkpointRef: prepared.checkpointRef,
              manifestHash: current.manifestRef,
              remoteHeadCommit,
              conflictPaths: applied.conflictPaths,
            };
          } finally {
            await prepared.discard();
          }
        },
      );
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  } finally {
    publication.release();
  }
};
