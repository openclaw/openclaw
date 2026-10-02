import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import {
  getSessionRepositoryWorkspaceStore,
  type PreparedRepositoryWorkspace,
} from "../state/session-repository-workspaces.js";
import {
  prepareGitHubPublicationWorkspaceOwner,
  type PublicationSessionIdentity,
} from "./github-publication-availability.js";
import { GitHubPublicationSessionChangedError } from "./github-publication-failure.js";
import { projectGitHubPublicationResult } from "./github-publication-store.js";
import {
  readGitHubRepositoryPublicationMetadata,
  type GitHubRepositoryPublicationSnapshot,
} from "./github-repository-publication-snapshot.js";
import { failRepositoryGitHubPublicationPreparation } from "./github-repository-publication-store.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";
import { withSessionRepositoryCheckpoint } from "./worker-environments/session-repository-checkpoints.js";

export type PreparedRepositoryPublicationSnapshot = {
  snapshot: GitHubRepositoryPublicationSnapshot;
  snapshotRoot: string;
  checkpointRef: string;
  digest: string;
};

export async function prepareRepositoryOwner(session: PublicationSessionIdentity) {
  const current = await prepareGitHubPublicationWorkspaceOwner(session);
  return () => {
    const owner = current();
    if (owner.kind !== "repository") {
      throw new Error("GitHub publication repository owner changed.");
    }
    return owner;
  };
}

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
  prepared: PreparedRepositoryWorkspace,
) {
  const loaded = loadGatewaySessionEntryReadOnly(row.session_key, { agentId: row.agent_id });
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
  prepared: PreparedRepositoryWorkspace,
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
    prepared: PreparedRepositoryPublicationSnapshot,
  ) => Promise<T>,
): Promise<T | SessionGitHubPublicationResult> {
  const preparedOwner = await getSessionRepositoryWorkspaceStore().prepare(row.workspace_id);
  assertCurrent();
  const { workspace } = assertReceiptOwner(row, preparedOwner);
  if (!workspace.checkpointRef) {
    throw new Error("GitHub publication is waiting for the first accepted repository checkpoint.");
  }
  const assertSelected = () => {
    assertCurrent();
    const { workspace: current } = assertReceiptOwner(row, preparedOwner);
    if (
      current.revision !== workspace.revision ||
      current.checkpointRef !== workspace.checkpointRef
    ) {
      throw new Error("GitHub publication checkpoint changed during preparation.");
    }
  };
  return await withSessionRepositoryCheckpoint(
    {
      workspaceId: workspace.workspaceId,
      checkpointRef: workspace.checkpointRef,
      includePublication: true,
    },
    async (payload) => {
      assertSelected();
      if (!payload.publicationStagingRoot || !payload.publicationDigest) {
        return projectGitHubPublicationResult(
          failRepositoryGitHubPublicationPreparation(
            row,
            "Save a new checkpoint and request publication again. If capture remains unavailable, resolve any merge conflicts and review the repository's Git clean filters and transport configuration. Your session changes remain recoverable.",
            assertSelected,
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
          checkpoint_ref: workspace.checkpointRef,
          checkpoint_digest: payload.publicationDigest,
          source_head_commit: snapshot.baseCommit,
          source_index_tree: snapshot.baseTree,
          workspace_tree: snapshot.workspaceTree,
        },
        {
          snapshot,
          snapshotRoot: payload.publicationStagingRoot,
          checkpointRef: workspace.checkpointRef!,
          digest: payload.publicationDigest,
        },
      );
    },
  );
}
