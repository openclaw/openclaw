import type { DatabaseSync } from "node:sqlite";
import type { SessionEntry } from "../config/sessions/types.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { GitHubPublicationSessionChangedError } from "./github-publication-failure.js";

export type SharedGitHubPublicationSession = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  lifecycleRevision?: string | null;
};
export type SharedGitHubPublicationSelector = { requestId: string } | { idempotencyKey?: string };

export function readSharedGitHubPublicationSession(
  session: SharedGitHubPublicationSession,
  loaded: { agentId: string; canonicalKey: string; entry?: SessionEntry },
) {
  const entry = loaded.entry;
  if (
    !entry ||
    loaded.agentId !== session.agentId ||
    loaded.canonicalKey !== session.sessionKey ||
    entry.sessionId !== session.sessionId ||
    (session.lifecycleRevision !== undefined &&
      (entry.lifecycleRevision ?? null) !== session.lifecycleRevision)
  ) {
    throw new GitHubPublicationSessionChangedError();
  }
  return entry;
}

/** Execution resolvers open mutable stores. Observation uses their recorded owners on this reader. */
export function readSharedGitHubPublicationWorkspace(
  db: DatabaseSync,
  session: SharedGitHubPublicationSession,
  entry: SessionEntry,
) {
  if (entry.archivedAt !== undefined) {
    return undefined;
  }
  const query = getNodeSqliteKysely<Pick<DB, "worktrees" | "session_repository_workspaces">>(db);
  if (entry.repositoryWorkspaceId) {
    const workspace = tableExists(db, "session_repository_workspaces")
      ? executeSqliteQueryTakeFirstSync(
          db,
          query
            .selectFrom("session_repository_workspaces")
            .selectAll()
            .where("workspace_id", "=", entry.repositoryWorkspaceId),
        )
      : undefined;
    if (
      !workspace ||
      workspace.agent_id !== session.agentId ||
      workspace.session_key !== session.sessionKey
    ) {
      throw new Error("GitHub publication session repository owner is unavailable.");
    }
    return {
      kind: "repository" as const,
      workspaceId: workspace.workspace_id,
      branch: workspace.branch,
    };
  }
  if (!entry.worktree?.id) {
    return undefined;
  }
  const worktree = tableExists(db, "worktrees")
    ? executeSqliteQueryTakeFirstSync(
        db,
        query
          .selectFrom("worktrees")
          .select(["id", "branch", "repo_root", "repo_fingerprint"])
          .where("owner_kind", "=", "session")
          .where("owner_id", "=", session.sessionKey)
          .where("removed_at", "is", null)
          .orderBy("created_at", "desc")
          .limit(1),
      )
    : undefined;
  if (
    !worktree ||
    worktree.id !== entry.worktree.id ||
    worktree.branch !== entry.worktree.branch ||
    worktree.repo_root !== entry.worktree.repoRoot
  ) {
    throw new Error("GitHub publication session worktree owner is unavailable.");
  }
  return {
    kind: "worktree" as const,
    worktreeId: worktree.id,
    branch: worktree.branch,
    repositoryFingerprint: worktree.repo_fingerprint,
  };
}
