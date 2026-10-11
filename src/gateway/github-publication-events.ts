import type { DatabaseSync } from "node:sqlite";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";

/** The existing transaction owner discards these observers on rollback, including savepoints. */
export function deferSharedGitHubPublicationChanged(
  db: DatabaseSync,
  row: {
    session_key: string;
    agent_id: string;
    identity_source: string;
    owner_profile_id?: string | null;
  },
): void {
  if (row.identity_source === "personal" || row.owner_profile_id != null) {
    return;
  }
  deferSqlitePostCommitPublication(db, () => {
    emitSessionLifecycleEvent({
      sessionKey: row.session_key,
      agentId: row.agent_id,
      reason: "github-publication",
    });
  });
}
