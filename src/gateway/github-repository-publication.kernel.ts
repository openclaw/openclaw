import { createHash } from "node:crypto";
import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import type { WorkerSessionTurnClaim } from "./worker-environments/placement-record.js";

export function repositoryGitHubPublicationDigest(row: RepositoryGitHubPublicationRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.request_id,
        row.owner_profile_id,
        row.connection_generation,
        row.idempotency_key,
        row.session_id,
        row.session_lifecycle_revision,
        row.session_key,
        row.agent_id,
        row.workspace_id,
        row.identity_source,
        row.identity_profile_id,
        row.identity_account_id,
        row.identity_login,
        row.title,
        row.body,
        row.push_repository,
        row.repository,
        row.branch,
        row.base_branch,
        row.checkpoint_ref,
        row.checkpoint_digest,
        row.source_head_commit,
        row.source_index_tree,
        row.workspace_tree,
        row.previous_head_commit,
        row.created_at_ms,
        ...(row.requester_authority_json !== null ? [row.requester_authority_json] : []),
      ]),
    )
    .digest("hex");
}

export function checkRepositoryGitHubPublication(
  row: RepositoryGitHubPublicationRow,
): RepositoryGitHubPublicationRow {
  if (
    repositoryGitHubPublicationDigest(row) !== row.request_digest ||
    (row.identity_source === "personal") !== (row.owner_profile_id !== null) ||
    (row.owner_profile_id !== null && row.requester_authority_json !== null)
  ) {
    throw new Error("GitHub repository publication receipt is corrupt.");
  }
  return row;
}

export type RepositoryGitHubPublicationPendingQuery = {
  ownerProfileId: string;
  sessionKey: string;
  agentId: string;
};

export function projectRepositoryGitHubPublicationStatus(row: RepositoryGitHubPublicationRow) {
  return {
    request_id: row.request_id,
    owner_profile_id: row.owner_profile_id,
    connection_generation: row.connection_generation,
    request_digest: row.request_digest,
    session_id: row.session_id,
    session_lifecycle_revision: row.session_lifecycle_revision,
    session_key: row.session_key,
    agent_id: row.agent_id,
    workspace_id: row.workspace_id,
    identity_source: row.identity_source,
    identity_account_id: row.identity_account_id,
    identity_login: row.identity_login,
    status: row.status,
    gateway_instance_id: row.gateway_instance_id,
    execution_id: row.execution_id,
    push_repository: row.push_repository,
    repository: row.repository,
    branch: row.branch,
    base_branch: row.base_branch,
    source_head_commit: row.source_head_commit,
    source_index_tree: row.source_index_tree,
    workspace_tree: row.workspace_tree,
    head_commit: row.head_commit,
    pull_request_url: row.pull_request_url,
    error_code: row.error_code,
    next_action: row.next_action,
    last_effect: row.last_effect,
    effect_state: row.effect_state,
  };
}

export type RepositoryGitHubPublicationStatusRow = ReturnType<
  typeof projectRepositoryGitHubPublicationStatus
>;

export type RepositoryGitHubPublicationFilter = {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  workspaceId?: string;
  ownerProfileId?: string | null;
  idempotencyKey?: string;
  pending?: boolean;
  unreported?: boolean;
};

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
