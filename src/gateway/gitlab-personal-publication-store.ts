import { createHash } from "node:crypto";
import type { DB } from "../state/openclaw-state-db.generated.js";

export type PersonalGitLabPublicationRow = DB["gitlab_personal_publication_requests"];

/** The accepted request is immutable; execution and result columns are outside this digest. */
export function personalGitLabRequestDigest(row: PersonalGitLabPublicationRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.request_id,
        row.owner_profile_id,
        row.issuer,
        row.connection_generation,
        row.idempotency_key,
        row.session_id,
        row.session_key,
        row.agent_id,
        row.session_lifecycle_revision,
        row.worktree_id,
        row.repository_fingerprint,
        row.identity_account_id,
        row.identity_login,
        row.branch,
        row.receipt_json,
        row.created_at_ms,
      ]),
    )
    .digest("hex");
}
