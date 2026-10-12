import { createHash } from "node:crypto";
import type { DB } from "../state/openclaw-state-db.generated.js";

export type PersonalGitHubPublicationRow = DB["github_personal_publication_requests"];

export function personalGitHubRequestDigest(row: PersonalGitHubPublicationRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.request_id,
        row.owner_profile_id,
        row.session_id,
        row.session_key,
        row.agent_id,
        row.idempotency_key,
        row.connection_generation,
        row.identity_source,
        row.identity_profile_id,
        row.identity_account_id,
        row.identity_login,
        row.worktree_id,
        row.repository_fingerprint,
        row.push_repository,
        row.repository,
        row.branch,
        row.base_branch,
        row.source_head_commit,
        row.source_index_tree,
        row.workspace_tree,
        row.title,
        row.body,
        row.created_at_ms,
      ]),
    )
    .digest("hex");
}
