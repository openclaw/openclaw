import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { GitHubPublicationRow as PublicationRow } from "../state/github-publication-read.types.js";
import type { resolveGitHubPublicationWorktreeOwner } from "./github-publication-availability.js";
import { githubPublicationDatabase as publicationDb } from "./github-publication-store.js";
import type { WorkerSessionTurnClaim } from "./worker-environments/placement-store.js";

export function sameWorktree(
  row: PublicationRow,
  worktree: ReturnType<typeof resolveGitHubPublicationWorktreeOwner>["worktree"],
): boolean {
  return (
    row.worktree_id === worktree.id &&
    row.repository_fingerprint === worktree.repoFingerprint &&
    row.branch === worktree.branch
  );
}

export function sameClaim(row: PublicationRow, claim: WorkerSessionTurnClaim): boolean {
  return (
    row.claim_id === claim.claimId &&
    row.run_id === claim.runId &&
    row.placement_generation === claim.placementGeneration &&
    row.environment_id === (claim.owner.environmentId ?? null) &&
    row.owner_epoch === (claim.owner.ownerEpoch ?? null)
  );
}

export function assertStoredClaim(
  db: Parameters<typeof getNodeSqliteKysely>[0],
  request: {
    claim: WorkerSessionTurnClaim;
    sessionKey: string;
    agentId: string;
  },
): void {
  const row = executeSqliteQuerySync(
    db,
    publicationDb(db)
      .selectFrom("worker_session_placements")
      .select([
        "agent_id",
        "session_key",
        "state",
        "environment_id",
        "active_owner_epoch",
        "turn_claim_owner",
        "turn_claim_id",
        "turn_claim_run_id",
        "turn_claim_generation",
        "turn_claim_owner_epoch",
      ])
      .where("session_id", "=", request.claim.sessionId),
  ).rows[0];
  const ownerMatches =
    request.claim.owner.kind === "worker"
      ? row?.turn_claim_owner === "worker" &&
        row.environment_id === request.claim.owner.environmentId &&
        row.active_owner_epoch === request.claim.owner.ownerEpoch &&
        row.turn_claim_owner_epoch === request.claim.owner.ownerEpoch
      : row?.turn_claim_owner === "local";
  if (
    !row ||
    (row.state !== "active" && row.state !== "draining" && row.state !== "local") ||
    row.agent_id !== request.agentId ||
    row.session_key !== request.sessionKey ||
    row.turn_claim_id !== request.claim.claimId ||
    row.turn_claim_run_id !== request.claim.runId ||
    row.turn_claim_generation !== request.claim.placementGeneration ||
    !ownerMatches
  ) {
    throw new Error("GitHub publication turn authority changed before recording.");
  }
}
