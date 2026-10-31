import { createHash } from "node:crypto";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import {
  prepareGitHubPublicationWorkspaceOwner,
  prepareGitHubPublicationSession,
} from "./github-publication-availability.js";
import { GitHubPublicationSessionChangedError } from "./github-publication-failure.js";
import { projectGitHubPublicationResult } from "./github-publication-receipt.js";
import type { PublicationSessionIdentity } from "./github-publication-session.types.js";
import {
  failRepositoryGitHubPublicationPreparationAsync,
  type GitHubPublicationTransitionAuthority,
} from "./github-publication-store-async.js";
import {
  readGitHubRepositoryPublicationMetadata,
  type GitHubRepositoryPublicationSnapshot,
} from "./github-repository-publication-snapshot.js";
import { captureRepositoryDiskCheckpoint } from "./worker-environments/repository-workspace-snapshot.js";
import { withSessionRepositoryCheckpoint } from "./worker-environments/session-repository-checkpoints.js";
import { workerWorkspaceResultRef } from "./worker-environments/workspace-result-staging.js";

export type RepositoryDiskPublicationSource = Pick<
  Parameters<typeof captureRepositoryDiskCheckpoint>[0],
  "placements" | "environments"
> & { captureRequestIds?: readonly string[] };

export async function prepareRepositoryOwner(session: PublicationSessionIdentity) {
  const current = await prepareGitHubPublicationWorkspaceOwner(session);
  return Object.assign(current.currentRepository, { release: current.release });
}

export async function prepareReceiptOwner(row: {
  session_key: string;
  agent_id: string;
  workspace_id: string;
}) {
  const session = await prepareGitHubPublicationSession(row.session_key, { agentId: row.agent_id });
  try {
    const repository = await getSessionRepositoryWorkspaceStore().prepare(row.workspace_id);
    return { ...repository, session, release: () => session.release() };
  } catch (error) {
    session.release();
    throw error;
  }
}

type PreparedReceiptOwner = Awaited<ReturnType<typeof prepareReceiptOwner>>;

export function resolveReceiptOwner(
  row: Pick<
    RepositoryGitHubPublicationRow,
    | "session_key"
    | "agent_id"
    | "session_id"
    | "session_lifecycle_revision"
    | "workspace_id"
    | "branch"
  >,
  prepared: PreparedReceiptOwner,
) {
  let loaded: ReturnType<typeof prepared.session.readCurrent>;
  try {
    loaded = prepared.session.readCurrent();
  } catch (error) {
    if (error instanceof GitHubPublicationSessionChangedError) {
      return undefined;
    }
    throw error;
  }
  const workspace = prepared.current();
  if (
    loaded.entry?.sessionId !== row.session_id ||
    (loaded.entry.lifecycleRevision ?? null) !== row.session_lifecycle_revision ||
    loaded.canonicalKey !== row.session_key ||
    loaded.agentId !== row.agent_id ||
    loaded.entry.archivedAt !== undefined ||
    !workspace ||
    workspace.workspaceId !== row.workspace_id ||
    workspace.agentId !== row.agent_id ||
    workspace.sessionKey !== row.session_key ||
    workspace.branch !== row.branch ||
    loaded.entry.repositoryWorkspaceId !== row.workspace_id
  ) {
    return undefined;
  }
  return { loaded, workspace };
}

export function assertReceiptOwner(
  row: RepositoryGitHubPublicationRow,
  prepared: PreparedReceiptOwner,
) {
  const owner = resolveReceiptOwner(row, prepared);
  if (!owner) {
    throw new GitHubPublicationSessionChangedError();
  }
  return owner;
}

export async function captureCheckpoint<T>(
  row: RepositoryGitHubPublicationRow,
  assertCurrent: () => void,
  use: (
    facts: Pick<
      RepositoryGitHubPublicationRow,
      | "checkpoint_ref"
      | "checkpoint_digest"
      | "source_head_commit"
      | "source_index_tree"
      | "workspace_tree"
    >,
    prepared: {
      snapshot: GitHubRepositoryPublicationSnapshot;
      snapshotRoot: string;
      authority: GitHubPublicationTransitionAuthority;
    },
  ) => Promise<T>,
  authority: GitHubPublicationTransitionAuthority,
  disk?: RepositoryDiskPublicationSource,
): Promise<T | SessionGitHubPublicationResult> {
  let checkpointRef = row.checkpoint_ref;
  let assertSelected = assertCurrent;
  let releaseOwner: (() => void) | undefined;
  using _ = { [Symbol.dispose]: () => releaseOwner?.() };

  if (!checkpointRef) {
    const preparedOwner = await prepareReceiptOwner(row);
    releaseOwner = preparedOwner.release;
    assertCurrent();
    const { workspace } = assertReceiptOwner(row, preparedOwner);
    assertSelected = () => {
      assertCurrent();
      const { workspace: current } = assertReceiptOwner(row, preparedOwner);
      if (
        current.revision !== workspace.revision ||
        current.checkpointRef !== workspace.checkpointRef
      ) {
        throw new Error("GitHub publication checkpoint changed during preparation.");
      }
    };
    if (workspace.diskAuthority) {
      if (!disk) {
        throw new Error(
          "GitHub publication requires a fresh snapshot from the repository disk; a stored mirror cannot be used.",
        );
      }
      // Every recovery path can recover this identity from the durable request alone.
      const requestRef = (requestId: string) =>
        workerWorkspaceResultRef(
          "publication-" +
            createHash("sha256")
              .update(JSON.stringify([workspace.workspaceId, requestId]))
              .digest("hex"),
        );
      const ref = requestRef(row.request_id);
      checkpointRef = (
        await captureRepositoryDiskCheckpoint(
          {
            ...disk,
            repository: workspace,
            checkpointRef: ref,
            additionalRefs: disk.captureRequestIds?.map(requestRef),
            purpose: "publication",
            identity: {
              sessionId: row.session_id,
              sessionKey: row.session_key,
              agentId: row.agent_id,
            },
            assertCurrent: assertSelected,
          },
          async (snapshot) => snapshot,
        )
      ).checkpointRef;
    } else {
      checkpointRef = workspace.checkpointRef ?? null;
    }
    if (!checkpointRef) {
      throw new Error(
        "GitHub publication is waiting for the first accepted repository checkpoint.",
      );
    }
  }
  const selectedAuthority: GitHubPublicationTransitionAuthority = {
    ...authority,
    assertAction: assertSelected,
  };
  return await withSessionRepositoryCheckpoint(
    {
      workspaceId: row.workspace_id,
      checkpointRef: checkpointRef ?? undefined,
    },
    async (payload) => {
      assertSelected();
      if (
        row.checkpoint_ref &&
        (!payload.publicationStagingRoot ||
          !payload.publicationDigest ||
          payload.publicationDigest !== row.checkpoint_digest)
      ) {
        throw new Error("GitHub publication accepted checkpoint is unavailable.");
      }
      if (!payload.publicationStagingRoot || !payload.publicationDigest) {
        const nextAction =
          "Save a new checkpoint and request publication again. If capture remains unavailable, resolve any merge conflicts and review the repository's Git clean filters and transport configuration. Your session changes remain recoverable.";
        return projectGitHubPublicationResult(
          await failRepositoryGitHubPublicationPreparationAsync(row, nextAction, () =>
            selectedAuthority.assertCustody(),
          ),
        );
      }
      const { snapshot } = await readGitHubRepositoryPublicationMetadata(
        payload.publicationStagingRoot,
        payload.publicationDigest,
      );
      assertSelected();
      return await use(
        {
          checkpoint_ref: checkpointRef,
          checkpoint_digest: payload.publicationDigest,
          source_head_commit: snapshot.baseCommit,
          source_index_tree: snapshot.baseTree,
          workspace_tree: snapshot.workspaceTree,
        },
        { snapshot, snapshotRoot: payload.publicationStagingRoot, authority: selectedAuthority },
      );
    },
  );
}
