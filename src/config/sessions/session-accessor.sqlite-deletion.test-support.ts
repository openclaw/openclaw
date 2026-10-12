import { randomUUID } from "node:crypto";
import { personalGitHubRequestDigest } from "../../gateway/github-personal-publication-store.js";
import {
  insertPersonalGitHubPublicationInDatabase,
  readPersonalGitHubPublicationInDatabase,
  type PersonalGitHubPublicationRow,
} from "../../gateway/github-personal-publication-store.worker.js";
import { readGitHubPublicationSessionLifecycle } from "../../state/github-publication-session-lifecycles.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { ensureCanonicalUserProfileForEmail } from "../../state/user-profile-writes.js";

export async function seedPersonalGitHubDeletionReceipt(key: string, sessionId: string) {
  const owner = (await ensureCanonicalUserProfileForEmail("receipt-owner@example.test")).id;
  const row: PersonalGitHubPublicationRow = {
    request_id: randomUUID(),
    owner_profile_id: owner,
    connection_generation: "11111111-1111-4111-8111-111111111111",
    idempotency_key: key,
    request_digest: "",
    session_id: sessionId,
    session_key: key,
    agent_id: "main",
    worktree_id: "retired-worktree",
    repository_fingerprint: "fixture-repository",
    identity_source: "personal",
    identity_profile_id: "ghp_22222222222222222222222222222222",
    identity_account_id: 12345,
    identity_login: "fixture-user",
    title: "Synthetic publication",
    body: null,
    status: "requested",
    gateway_instance_id: "fixture-gateway",
    execution_id: null,
    push_repository: "openclaw/fixture",
    repository: "openclaw/fixture",
    branch: "fixture-branch",
    base_branch: "main",
    source_head_commit: "a".repeat(40),
    source_index_tree: "b".repeat(40),
    workspace_tree: "b".repeat(40),
    head_commit: null,
    pull_request_url: null,
    error_code: null,
    next_action: null,
    last_effect: null,
    effect_state: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    reported_at_ms: null,
  };
  row.request_digest = personalGitHubRequestDigest(row);
  runOpenClawStateWriteTransaction((database) =>
    insertPersonalGitHubPublicationInDatabase(database, row, "generation-1", () => {}),
  );
  return () => ({
    receipt: readPersonalGitHubPublicationInDatabase(openOpenClawStateDatabase().db, owner, {
      requestId: row.request_id,
    }),
    lifecycle: readGitHubPublicationSessionLifecycle({
      publicationKind: "personal",
      requestId: row.request_id,
    }),
  });
}
