import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { createOpenClawStateSchemaEnsurer } from "../../state/openclaw-state-feature-schema.js";

export type WorktreeTemplateRecord = {
  cacheKey: string;
  id: string;
  repoRoot: string;
  commonDir: string;
  worktreeRoot: string;
  path: string;
  backend: string;
  sourceCommit: string;
  contentKey: string;
  status: "preparing" | "ready";
  createdAt: number;
  lastUsedAt: number;
};

type TemplateDatabase = Pick<OpenClawStateKyselyDatabase, "worktree_templates">;
type TemplateRow = Selectable<TemplateDatabase["worktree_templates"]>;

const ensureTemplateSchema = createOpenClawStateSchemaEnsurer({
  table: "worktree_templates",
  operationLabel: "agents.worktrees.templates.schema.ensure",
});

function kyselyFor(db: DatabaseSync) {
  return getNodeSqliteKysely<TemplateDatabase>(db);
}

function rowToRecord(row: TemplateRow): WorktreeTemplateRecord {
  if (row.status !== "preparing" && row.status !== "ready") {
    throw new Error(`Invalid worktree template status: ${row.status}`);
  }
  return {
    cacheKey: row.cache_key,
    id: row.id,
    repoRoot: row.repo_root,
    commonDir: row.common_dir,
    worktreeRoot: row.worktree_root,
    path: row.path,
    backend: row.backend,
    sourceCommit: row.source_commit,
    contentKey: row.content_key,
    status: row.status,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function openTemplateDatabase(env: NodeJS.ProcessEnv): DatabaseSync {
  ensureTemplateSchema({ env });
  return openOpenClawStateDatabase({ env }).db;
}

export function readTemplate(
  env: NodeJS.ProcessEnv,
  cacheKey: string,
): WorktreeTemplateRecord | undefined {
  const db = openTemplateDatabase(env);
  const row = executeSqliteQuerySync(
    db,
    kyselyFor(db).selectFrom("worktree_templates").selectAll().where("cache_key", "=", cacheKey),
  ).rows[0];
  return row ? rowToRecord(row) : undefined;
}

export function listTemplates(env: NodeJS.ProcessEnv): WorktreeTemplateRecord[] {
  const db = openTemplateDatabase(env);
  return executeSqliteQuerySync(
    db,
    kyselyFor(db)
      .selectFrom("worktree_templates")
      .selectAll()
      .orderBy("last_used_at", "asc")
      .orderBy("id", "asc"),
  ).rows.map(rowToRecord);
}

// The service holds its allocation lease across filesystem work. This owner
// fences each durable mutation again inside the shared-state transaction.
function mutateTemplate<T>(
  env: NodeJS.ProcessEnv,
  commitGuard: () => void,
  operationLabel: string,
  mutate: (db: DatabaseSync) => T,
): T {
  commitGuard();
  ensureTemplateSchema({ env });
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      commitGuard();
      return mutate(db);
    },
    { env },
    { operationLabel },
  );
}

/** Reserve before creating the artifact; an occupied slot must be retired first. */
export function reserveTemplate(
  env: NodeJS.ProcessEnv,
  record: WorktreeTemplateRecord & { status: "preparing" },
  commitGuard: () => void,
): void {
  mutateTemplate(env, commitGuard, "agents.worktrees.templates.reserve", (db) => {
    executeSqliteQuerySync(
      db,
      kyselyFor(db).insertInto("worktree_templates").values({
        cache_key: record.cacheKey,
        id: record.id,
        repo_root: record.repoRoot,
        common_dir: record.commonDir,
        worktree_root: record.worktreeRoot,
        path: record.path,
        backend: record.backend,
        source_commit: record.sourceCommit,
        content_key: record.contentKey,
        status: record.status,
        created_at: record.createdAt,
        last_used_at: record.lastUsedAt,
      }),
    );
  });
}

export function markTemplateReady(
  env: NodeJS.ProcessEnv,
  id: string,
  now: number,
  commitGuard: () => void,
): boolean {
  return mutateTemplate(env, commitGuard, "agents.worktrees.templates.ready", (db) => {
    return (
      executeSqliteQuerySync(
        db,
        kyselyFor(db)
          .updateTable("worktree_templates")
          .set({ status: "ready", last_used_at: now })
          .where("id", "=", id)
          .where("status", "=", "preparing"),
      ).numAffectedRows === 1n
    );
  });
}

export function touchTemplate(
  env: NodeJS.ProcessEnv,
  id: string,
  now: number,
  commitGuard: () => void,
): boolean {
  return mutateTemplate(env, commitGuard, "agents.worktrees.templates.touch", (db) => {
    return (
      executeSqliteQuerySync(
        db,
        kyselyFor(db)
          .updateTable("worktree_templates")
          .set({ last_used_at: now })
          .where("id", "=", id)
          .where("status", "=", "ready"),
      ).numAffectedRows === 1n
    );
  });
}

/** A stale cleanup must never delete a replacement occupying the same cache key. */
export function deleteTemplate(
  env: NodeJS.ProcessEnv,
  id: string,
  commitGuard: () => void,
): boolean {
  return mutateTemplate(env, commitGuard, "agents.worktrees.templates.delete", (db) => {
    return (
      executeSqliteQuerySync(
        db,
        kyselyFor(db).deleteFrom("worktree_templates").where("id", "=", id),
      ).numAffectedRows === 1n
    );
  });
}
