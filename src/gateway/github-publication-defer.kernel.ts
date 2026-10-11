import type { DatabaseSync } from "node:sqlite";
import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import type { GitHubPublicationDeferral } from "../state/github-publication-worker.types.js";
import {
  listGitHubPublicationsForClaimInDatabase,
  listSharedGitHubPublicationsInDatabase,
  readGitHubPublicationRequest,
} from "./github-publication-store.js";
import { listRepositoryGitHubPublicationsInDatabase } from "./github-repository-publication.kernel.js";
import {
  projectWorkerSessionTurnClaim,
  type WorkerSessionTurnClaim,
} from "./worker-environments/placement-record.js";
import { readWorkerPlacementsInDatabase } from "./worker-environments/placement-row-codec.js";
import { listPendingWorkerWorkspaceResultsInDatabase } from "./worker-environments/placement-workspace-result.js";

export function matchesRepositoryGitHubPublicationClaim(
  row: RepositoryGitHubPublicationRow,
  claim: WorkerSessionTurnClaim,
): boolean {
  return (
    row.environment_id !== null &&
    row.owner_epoch !== null &&
    row.session_id === claim.sessionId &&
    row.claim_id === claim.claimId &&
    row.run_id === claim.runId &&
    row.placement_generation === claim.placementGeneration &&
    row.environment_id === (claim.owner.environmentId ?? null) &&
    row.owner_epoch === (claim.owner.ownerEpoch ?? null)
  );
}

/** Selection shares the destination transaction with deferral, including pending-result custody. */
export function selectGitHubPublicationDeferralsInDatabase(
  db: DatabaseSync,
  kind: "shared" | "repository",
  selection: GitHubPublicationDeferral,
): string[] {
  if (selection.kind === "request") {
    if (kind !== "shared") {
      throw new Error("Exact deferral requires a shared GitHub publication.");
    }
    const expected = selection.row;
    const current = readGitHubPublicationRequest(db, { requestId: expected.request_id });
    return current &&
      current.request_digest === expected.request_digest &&
      current.claim_id === expected.claim_id &&
      current.run_id === expected.run_id &&
      current.environment_id === expected.environment_id &&
      current.owner_epoch === expected.owner_epoch &&
      current.placement_generation === expected.placement_generation &&
      current.gateway_instance_id === expected.gateway_instance_id &&
      (current.status === "requested" || current.status === "publishing")
      ? [current.request_id]
      : [];
  }
  if (selection.kind === "claim" || selection.kind === "claimMissingSnapshot") {
    if (selection.kind === "claimMissingSnapshot") {
      if (kind !== "shared") {
        throw new Error("Missing-snapshot deferral requires a shared GitHub publication.");
      }
      return listGitHubPublicationsForClaimInDatabase(db, selection.claim, { pendingOnly: true })
        .filter((row) => !row.source_head_commit || !row.source_index_tree || !row.workspace_tree)
        .map((row) => row.request_id);
    }
    return (
      kind === "shared"
        ? listGitHubPublicationsForClaimInDatabase(db, selection.claim, { pendingOnly: true })
        : listRepositoryGitHubPublicationsInDatabase(db, {
            sessionId: selection.claim.sessionId,
            ownerProfileId: null,
            pending: true,
          }).filter((row) => matchesRepositoryGitHubPublicationClaim(row, selection.claim))
    ).map((row) => row.request_id);
  }
  const rows =
    kind === "shared"
      ? listSharedGitHubPublicationsInDatabase(db, { pending: true })
      : listRepositoryGitHubPublicationsInDatabase(db, { ownerProfileId: null, pending: true });
  if (!rows.length) {
    return [];
  }
  const pending = new Set(
    listPendingWorkerWorkspaceResultsInDatabase(db).map(
      (row) => `${row.sessionId}\0${row.claimId}\0${row.runId}`,
    ),
  );
  const placements = new Map(
    readWorkerPlacementsInDatabase(
      db,
      rows.map((row) => row.session_id),
    ).map((row) => [row.sessionId, row]),
  );
  return rows.flatMap((row) => {
    if (!row.claim_id || pending.has(`${row.session_id}\0${row.claim_id}\0${row.run_id}`)) {
      return [];
    }
    const placement = placements.get(row.session_id);
    const claim = placement?.turnClaim;
    let live =
      claim?.claimId === row.claim_id &&
      claim.runId === row.run_id &&
      claim.generation === row.placement_generation;
    if (kind === "repository" && live) {
      live = Boolean(
        placement &&
        (claim?.owner === "local" || projectWorkerSessionTurnClaim(placement)) &&
        row.environment_id !== null &&
        row.owner_epoch !== null &&
        row.environment_id === placement.environmentId &&
        row.owner_epoch === placement.activeOwnerEpoch,
      );
    }
    return live ? [] : [row.request_id];
  });
}
