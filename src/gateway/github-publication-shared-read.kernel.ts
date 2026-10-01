import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type {
  GitHubPublicationRow,
  RepositoryGitHubPublicationRow,
  SharedGitHubPublicationReadInput,
} from "../state/github-publication-read.types.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  assertReadableSharedGitHubPublication,
  checkSharedWorktreeReceipt,
  githubPublicationDatabase,
} from "./github-publication-store.js";
import { checkRepositoryGitHubPublication as checked } from "./github-repository-publication.kernel.js";

const table = "github_repository_publication_requests";
const repositoryQuery = (db: DatabaseSync) => getNodeSqliteKysely<Pick<DB, typeof table>>(db);

/** Execution resolvers open mutable stores. Observation uses their recorded owners on this reader. */
function readSharedGitHubPublicationWorkspace(
  db: DatabaseSync,
  session: SharedGitHubPublicationReadInput["session"],
  entry: SharedGitHubPublicationReadInput["entry"],
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

/** Shared observation never initializes schema, prepares identity, or resumes publication. */
export function readSharedGitHubPublicationRequestInDatabase(
  db: DatabaseSync,
  session: SharedGitHubPublicationReadInput["session"],
  selector: SharedGitHubPublicationReadInput["selector"],
  entry: SharedGitHubPublicationReadInput["entry"],
): GitHubPublicationRow | undefined {
  return runSqliteDeferredTransactionSync(db, () => {
    if (!tableExists(db, "github_publication_requests")) {
      return undefined;
    }
    let selection = githubPublicationDatabase(db)
      .selectFrom("github_publication_requests")
      .selectAll("github_publication_requests")
      .where("session_key", "=", session.sessionKey)
      .where("agent_id", "=", session.agentId);
    if ("requestId" in selector) {
      selection = selection.where(
        "github_publication_requests.request_id",
        "=",
        selector.requestId,
      );
      const row = executeSqliteQueryTakeFirstSync(db, selection);
      if (!row) {
        return undefined;
      }
      checkSharedWorktreeReceipt(row);
      // An explicitly selected terminal receipt is history, not discovery of the current workspace.
      if (row.status === "published" || row.status === "failed") {
        return row;
      }
    } else if (selector.idempotencyKey !== undefined) {
      selection = selection.where("idempotency_key", "=", selector.idempotencyKey);
    }
    const hasLifecycle = tableExists(db, "github_publication_session_lifecycles");
    const ordered = selection
      .leftJoin("github_publication_session_lifecycles as lifecycle", (join) =>
        join
          .onRef("lifecycle.request_id", "=", "github_publication_requests.request_id")
          .on("lifecycle.publication_kind", "=", "shared"),
      )
      .where((eb) =>
        eb.or([
          eb("lifecycle.request_id", "is not", null),
          eb("github_publication_requests.status", "not in", ["published", "failed"]),
        ]),
      )
      .select(["lifecycle.request_id as lifecycle_request_id", "lifecycle.lifecycle_revision"])
      .orderBy("created_at_ms", "desc")
      .orderBy("github_publication_requests.request_id", "desc")
      .limit(64);
    // Completed receipts can predate lifecycle bindings. They are unqualified history,
    // not current workspace evidence; pending receipts still fail closed when unbound.
    const candidate = hasLifecycle
      ? executeSqliteQueryTakeFirstSync(db, ordered.limit(1))
      : undefined;
    const existing = hasLifecycle
      ? candidate
      : executeSqliteQueryTakeFirstSync(
          db,
          selection.where("status", "not in", ["published", "failed"]).limit(1),
        );
    if (!existing) {
      return undefined;
    }
    const workspace = readSharedGitHubPublicationWorkspace(db, session, entry);
    if (workspace?.kind !== "worktree") {
      return undefined;
    }
    if (!candidate) {
      throw new Error("GitHub publication session binding is unavailable.");
    }
    const revision = entry.lifecycleRevision ?? null;
    const matchesWorkspace = (row: typeof candidate) =>
      row.session_id === session.sessionId &&
      row.lifecycle_revision === revision &&
      row.worktree_id === workspace.worktreeId &&
      row.repository_fingerprint === workspace.repositoryFingerprint &&
      row.branch === workspace.branch;
    if (candidate.lifecycle_request_id !== null && matchesWorkspace(candidate)) {
      checkSharedWorktreeReceipt(candidate);
      return candidate;
    }
    let cursor: GitHubPublicationRow | undefined;
    for (;;) {
      const after = cursor;
      const page = after
        ? ordered.where((eb) =>
            eb.or([
              eb("created_at_ms", "<", after.created_at_ms),
              eb.and([
                eb("created_at_ms", "=", after.created_at_ms),
                eb("github_publication_requests.request_id", "<", after.request_id),
              ]),
            ]),
          )
        : ordered;
      const rows = executeSqliteQuerySync(db, page).rows;
      for (const row of rows) {
        checkSharedWorktreeReceipt(row);
        if (row.lifecycle_request_id === null) {
          throw new Error("GitHub publication session binding is unavailable.");
        }
        if (matchesWorkspace(row)) {
          return row;
        }
      }
      if (rows.length < 64) {
        return undefined;
      }
      cursor = rows[rows.length - 1]!;
    }
  });
}

/** Filter the mixed table before decoding; a private request ID never grants shared access. */
export function readSharedRepositoryGitHubPublicationInDatabase(
  db: DatabaseSync,
  session: SharedGitHubPublicationReadInput["session"],
  selector: SharedGitHubPublicationReadInput["selector"],
  entry: SharedGitHubPublicationReadInput["entry"],
): RepositoryGitHubPublicationRow | undefined {
  return runSqliteDeferredTransactionSync(db, () => {
    if (!tableExists(db, table)) {
      return undefined;
    }
    let selection = repositoryQuery(db)
      .selectFrom(table)
      .selectAll()
      .where("owner_profile_id", "is", null)
      .where("session_key", "=", session.sessionKey)
      .where("agent_id", "=", session.agentId);
    if ("requestId" in selector) {
      selection = selection.where("request_id", "=", selector.requestId);
      const row = executeSqliteQueryTakeFirstSync(db, selection);
      if (!row) {
        return undefined;
      }
      checked(row);
      assertReadableSharedGitHubPublication(row);
      if (row.status === "published" || row.status === "failed") {
        return row;
      }
    } else {
      if (selector.idempotencyKey !== undefined) {
        selection = selection.where("idempotency_key", "=", selector.idempotencyKey);
      }
      // No shared receipt means there is no workspace evidence to qualify. Personal-only
      // recovery must not depend on an unrelated shared workspace being available.
      if (!executeSqliteQueryTakeFirstSync(db, selection.limit(1))) {
        return undefined;
      }
    }
    const workspace = readSharedGitHubPublicationWorkspace(db, session, entry);
    if (workspace?.kind !== "repository") {
      return undefined;
    }
    const revision = entry.lifecycleRevision ?? null;
    const ordered = selection
      .orderBy("created_at_ms", "desc")
      .orderBy("request_id", "desc")
      .limit(64);
    let cursor: RepositoryGitHubPublicationRow | undefined;
    for (;;) {
      const after = cursor;
      const page = after
        ? ordered.where((eb) =>
            eb.or([
              eb("created_at_ms", "<", after.created_at_ms),
              eb.and([
                eb("created_at_ms", "=", after.created_at_ms),
                eb("request_id", "<", after.request_id),
              ]),
            ]),
          )
        : ordered;
      const rows = executeSqliteQuerySync(db, page).rows;
      for (const row of rows) {
        // Validate before scope filtering: a corrupted binding is not evidence of absence.
        checked(row);
        assertReadableSharedGitHubPublication(row);
        if (
          row.session_id === session.sessionId &&
          row.session_lifecycle_revision === revision &&
          row.workspace_id === workspace.workspaceId &&
          row.branch === workspace.branch
        ) {
          return row;
        }
      }
      if (rows.length < 64) {
        return undefined;
      }
      cursor = rows[rows.length - 1]!;
    }
  });
}
