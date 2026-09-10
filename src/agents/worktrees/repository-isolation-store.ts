import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { ensureWorktreeRepositoryGitIsolationSchema } from "../../state/openclaw-state-db-schema-additive.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";

type RepositoryIsolationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "worktree_repository_git_isolations"
>;

function kyselyFor(database: DatabaseSync) {
  return getNodeSqliteKysely<RepositoryIsolationDatabase>(database);
}

export function hasRepositoryGitIsolation(database: DatabaseSync, repoRoot: string): boolean {
  return Boolean(
    executeSqliteQuerySync(
      database,
      kyselyFor(database)
        .selectFrom("worktree_repository_git_isolations")
        .select("repo_root")
        .where("repo_root", "=", repoRoot)
        .limit(1),
    ).rows[0],
  );
}

export function getRegistryRepositoryGitIsolation(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): { sessionKey: string; agentId?: string } | undefined {
  const database = openOpenClawStateDatabase({ env }).db;
  if (!tableExists(database, "worktree_repository_git_isolations")) {
    return undefined;
  }
  const row = executeSqliteQuerySync(
    database,
    kyselyFor(database)
      .selectFrom("worktree_repository_git_isolations")
      .select(["session_key", "agent_id"])
      .where("repo_root", "=", repoRoot)
      .limit(1),
  ).rows[0];
  return row
    ? { sessionKey: row.session_key, ...(row.agent_id ? { agentId: row.agent_id } : {}) }
    : undefined;
}

export function setRegistryRepositorySandboxGit(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  isolation: { sessionKey: string; agentId?: string },
): void {
  const database = openOpenClawStateDatabase({ env }).db;
  ensureWorktreeRepositoryGitIsolationSchema(database);
  runOpenClawStateWriteTransaction(() => {
    executeSqliteQuerySync(
      database,
      kyselyFor(database)
        .insertInto("worktree_repository_git_isolations")
        .values({
          repo_root: repoRoot,
          session_key: isolation.sessionKey,
          agent_id: isolation.agentId ?? null,
        })
        .onConflict((conflict) =>
          conflict.column("repo_root").doUpdateSet({
            session_key: isolation.sessionKey,
            agent_id: isolation.agentId ?? null,
          }),
        ),
    );
    executeSqliteQuerySync(
      database,
      getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "worktrees">>(database)
        .updateTable("worktrees")
        .set({ sandbox_git: 1 })
        .where("repo_root", "=", repoRoot),
    );
  });
}
