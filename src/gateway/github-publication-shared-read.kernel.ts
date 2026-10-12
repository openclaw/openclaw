import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
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
} from "./github-publication-receipt.js";
import { githubPublicationDatabase } from "./github-publication-store.js";
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
    if (!workspace) {
      return undefined;
    }
    if (workspace.agent_id !== session.agentId || workspace.session_key !== session.sessionKey) {
      throw new Error("GitHub publication session repository owner is unavailable.");
    }
    return {
      kind: "repository" as const,
      workspaceId: workspace.workspace_id,
      branch: workspace.branch,
    };
  }
  if (!entry.worktree?.id || !tableExists(db, "worktrees")) {
    return undefined;
  }
  const worktree = executeSqliteQueryTakeFirstSync(
    db,
    query
      .selectFrom("worktrees")
      .select(["id", "branch", "repo_root", "repo_fingerprint"])
      .where("owner_kind", "=", "session")
      .where("owner_id", "=", session.sessionKey)
      .where("removed_at", "is", null)
      .orderBy("created_at", "desc")
      .limit(1),
  );
  if (worktree?.id !== entry.worktree.id) {
    const recorded = executeSqliteQueryTakeFirstSync(
      db,
      query
        .selectFrom("worktrees")
        .select(["owner_kind", "owner_id", "removed_at"])
        .where("id", "=", entry.worktree.id),
    );
    if (
      recorded?.removed_at === null &&
      (recorded.owner_kind !== "session" || recorded.owner_id !== session.sessionKey)
    ) {
      throw new Error("GitHub publication session worktree owner is unavailable.");
    }
  }
  // Worktree GC retires idle checkouts while the session keeps its record. A retired or
  // replaced checkout has no current publication; execution still re-proves ownership.
  if (
    !worktree ||
    worktree.id !== entry.worktree.id ||
    worktree.branch !== entry.worktree.branch ||
    worktree.repo_root !== entry.worktree.repoRoot
  ) {
    return undefined;
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
    // Unbound terminal receipts are history, not evidence of the current workspace.
    if (!tableExists(db, "github_publication_session_lifecycles")) {
      const pending = executeSqliteQueryTakeFirstSync(
        db,
        selection.where("status", "not in", ["published", "failed"]).limit(1),
      );
      if (
        pending &&
        readSharedGitHubPublicationWorkspace(db, session, entry)?.kind === "worktree"
      ) {
        throw new Error("GitHub publication session binding is unavailable.");
      }
      return undefined;
    }
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
      .orderBy("github_publication_requests.request_id", "desc");
    let workspace: ReturnType<typeof readSharedGitHubPublicationWorkspace>;
    for (const row of iterateSqliteQuerySync(db, ordered)) {
      workspace ??= readSharedGitHubPublicationWorkspace(db, session, entry);
      if (workspace?.kind !== "worktree") {
        return undefined;
      }
      checkSharedWorktreeReceipt(row);
      if (row.lifecycle_request_id === null) {
        throw new Error("GitHub publication session binding is unavailable.");
      }
      if (
        row.session_id === session.sessionId &&
        row.lifecycle_revision === (entry.lifecycleRevision ?? null) &&
        row.worktree_id === workspace.worktreeId &&
        row.repository_fingerprint === workspace.repositoryFingerprint &&
        row.branch === workspace.branch
      ) {
        return row;
      }
    }
    return undefined;
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
    } else if (selector.idempotencyKey !== undefined) {
      selection = selection.where("idempotency_key", "=", selector.idempotencyKey);
    }
    const ordered = selection.orderBy("created_at_ms", "desc").orderBy("request_id", "desc");
    let workspace: ReturnType<typeof readSharedGitHubPublicationWorkspace>;
    for (const row of iterateSqliteQuerySync(db, ordered)) {
      // An absent shared receipt must not make personal recovery depend on the workspace.
      workspace ??= readSharedGitHubPublicationWorkspace(db, session, entry);
      if (workspace?.kind !== "repository") {
        return undefined;
      }
      // Validate before scope filtering: a corrupted binding is not evidence of absence.
      checked(row);
      assertReadableSharedGitHubPublication(row);
      if (
        row.session_id === session.sessionId &&
        row.session_lifecycle_revision === (entry.lifecycleRevision ?? null) &&
        row.workspace_id === workspace.workspaceId &&
        row.branch === workspace.branch
      ) {
        return row;
      }
    }
    return undefined;
  });
}
