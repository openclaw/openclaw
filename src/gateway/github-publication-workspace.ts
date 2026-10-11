import type { GitHubPublicationRow as PublicationRow } from "../state/github-publication-read.types.js";
import { readGitHubPublicationWorktreeOwner } from "./github-publication-availability.js";
import { captureGitHubPublicationWorkspaceSnapshot } from "./github-publication-git-transport.js";
import {
  bindAcceptedGitHubPublicationClaimSnapshotAsync,
  listGitHubPublicationsForClaimAsync,
} from "./github-publication-store-async.js";
import {
  deferGitHubPublicationRequests as deferRequests,
  ensureGitHubPublicationStore as ensureSchema,
  listGitHubPublicationsForClaim,
} from "./github-publication-store.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";

export function sameWorktree(
  row: PublicationRow,
  worktree: Awaited<ReturnType<typeof readGitHubPublicationWorktreeOwner>>["worktree"],
): boolean {
  return (
    row.worktree_id === worktree.id &&
    row.repository_fingerprint === worktree.repoFingerprint &&
    row.branch === worktree.branch
  );
}

export async function prepareGitHubPublicationClaimWorkspace(
  params: { placements: WorkerSessionPlacementStore; assertCurrent: () => void },
  claim: WorkerSessionTurnClaim,
): Promise<void> {
  await params.placements.closeWorkerTurnToolAdmission(claim);
  const rows = await listGitHubPublicationsForClaimAsync(claim, { pendingOnly: true });
  if (rows.length === 0) {
    return;
  }
  await params.placements.prepareWorkspaceResultClaim(claim);
  const first = rows[0]!;
  const worktreeOwner = await readGitHubPublicationWorktreeOwner({
    sessionId: first.session_id,
    sessionKey: first.session_key,
    agentId: first.agent_id,
    expected: {
      worktreeId: first.worktree_id,
      repositoryFingerprint: first.repository_fingerprint,
      branch: first.branch,
    },
  });
  const { worktree } = worktreeOwner;
  if (!params.placements.validateWorkspaceResultClaim(claim)) {
    throw new Error("GitHub publication lost its workspace result claim before snapshot.");
  }
  for (const row of rows) {
    if (!sameWorktree(row, worktree)) {
      throw new Error("GitHub publication worktree changed before accepted snapshot.");
    }
  }
  const bound = rows.find(
    (row) => row.source_head_commit && row.source_index_tree && row.workspace_tree,
  );
  if (bound) {
    for (const row of rows) {
      if (
        (row.source_head_commit || row.source_index_tree || row.workspace_tree) &&
        (row.source_head_commit !== bound.source_head_commit ||
          row.source_index_tree !== bound.source_index_tree ||
          row.workspace_tree !== bound.workspace_tree)
      ) {
        throw new Error("GitHub publication accepted workspace snapshot changed.");
      }
    }
    if (
      rows.every((row) => row.source_head_commit && row.source_index_tree && row.workspace_tree)
    ) {
      return;
    }
  }
  const snapshot = await captureGitHubPublicationWorkspaceSnapshot({
    cwd: worktree.path,
    assertCurrent: () => {
      worktreeOwner.assertCurrent();
      if (!params.placements.validateWorkspaceResultClaim(claim)) {
        throw new Error("GitHub publication lost its workspace result claim during snapshot.");
      }
    },
  });
  for (const row of rows) {
    await bindAcceptedGitHubPublicationClaimSnapshotAsync({ row, claim, ...snapshot }, () => {
      params.assertCurrent();
      if (!params.placements.validateWorkspaceResultClaim(claim)) {
        throw new Error("GitHub publication lost its workspace result claim.");
      }
    });
  }
}

export function deferGitHubPublicationClaimPreparation(claim: WorkerSessionTurnClaim): void {
  ensureSchema();
  const rows = listGitHubPublicationsForClaim(claim, { pendingOnly: true });
  deferRequests(rows.map((row) => row.request_id));
}
