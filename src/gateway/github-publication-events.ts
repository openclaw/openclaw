import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";

export type GitHubPublicationChange = { sessionKey: string; agentId: string };
const workerChanges = new AsyncLocalStorage<GitHubPublicationChange[]>();

/** A worker carries the native owner's exact notifications with its commit receipt. */
export function captureGitHubPublicationChanges<T>(operation: () => T): {
  value: T;
  changes: GitHubPublicationChange[];
} {
  const changes: GitHubPublicationChange[] = [];
  return { value: workerChanges.run(changes, operation), changes };
}

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
  const captured = workerChanges.getStore();
  if (captured) {
    captured.push({ sessionKey: row.session_key, agentId: row.agent_id });
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
