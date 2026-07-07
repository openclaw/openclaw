import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import type { ManagedWorktreeOwnerKind, ManagedWorktreeRecord } from "./types.js";

type WorktreesTable = OpenClawStateKyselyDatabase["worktrees"];
type WorktreeRow = Selectable<WorktreesTable>;
type WorktreeRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "worktrees">;

function dbFor(env: NodeJS.ProcessEnv): DatabaseSync {
  return openOpenClawStateDatabase({ env }).db;
}

function kyselyFor(db: DatabaseSync) {
  return getNodeSqliteKysely<WorktreeRegistryDatabase>(db);
}

function rowToRecord(row: WorktreeRow): ManagedWorktreeRecord {
  return {
    id: row.id,
    name: row.path.split(/[\\/]/).at(-1) ?? row.id,
    repoFingerprint: row.repo_fingerprint,
    repoRoot: row.repo_root,
    path: row.path,
    branch: row.branch,
    baseRef: row.base_ref,
    ownerKind: row.owner_kind as ManagedWorktreeOwnerKind,
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    ...(row.snapshot_ref ? { snapshotRef: row.snapshot_ref } : {}),
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    ...(row.removed_at == null ? {} : { removedAt: row.removed_at }),
  };
}

function recordToRow(record: ManagedWorktreeRecord): Insertable<WorktreesTable> {
  return {
    id: record.id,
    repo_fingerprint: record.repoFingerprint,
    repo_root: record.repoRoot,
    path: record.path,
    branch: record.branch,
    base_ref: record.baseRef,
    owner_kind: record.ownerKind,
    owner_id: record.ownerId ?? null,
    snapshot_ref: record.snapshotRef ?? null,
    created_at: record.createdAt,
    last_active_at: record.lastActiveAt,
    removed_at: record.removedAt ?? null,
  };
}

export function listRegistryWorktrees(env: NodeJS.ProcessEnv): ManagedWorktreeRecord[] {
  const db = dbFor(env);
  const query = kyselyFor(db)
    .selectFrom("worktrees")
    .selectAll()
    .orderBy("created_at", "desc")
    .orderBy("id", "asc");
  return executeSqliteQuerySync(db, query).rows.map(rowToRecord);
}

export function getRegistryWorktree(
  env: NodeJS.ProcessEnv,
  id: string,
): ManagedWorktreeRecord | undefined {
  const db = dbFor(env);
  const query = kyselyFor(db).selectFrom("worktrees").selectAll().where("id", "=", id);
  const row = executeSqliteQuerySync(db, query).rows[0];
  return row ? rowToRecord(row) : undefined;
}

export function findLiveRegistryWorktreeByPath(
  env: NodeJS.ProcessEnv,
  worktreePath: string,
): ManagedWorktreeRecord | undefined {
  const db = dbFor(env);
  const query = kyselyFor(db)
    .selectFrom("worktrees")
    .selectAll()
    .where("path", "=", worktreePath)
    .where("removed_at", "is", null)
    .orderBy("created_at", "desc")
    .limit(1);
  const row = executeSqliteQuerySync(db, query).rows[0];
  return row ? rowToRecord(row) : undefined;
}

export function findLiveRegistryWorktreeByOwner(
  env: NodeJS.ProcessEnv,
  ownerKind: ManagedWorktreeOwnerKind,
  ownerId: string,
): ManagedWorktreeRecord | undefined {
  const db = dbFor(env);
  const query = kyselyFor(db)
    .selectFrom("worktrees")
    .selectAll()
    .where("owner_kind", "=", ownerKind)
    .where("owner_id", "=", ownerId)
    .where("removed_at", "is", null)
    .orderBy("created_at", "desc")
    .limit(1);
  const row = executeSqliteQuerySync(db, query).rows[0];
  return row ? rowToRecord(row) : undefined;
}

export function findRegistryWorktreeByPath(
  env: NodeJS.ProcessEnv,
  worktreePath: string,
): ManagedWorktreeRecord | undefined {
  const db = dbFor(env);
  const query = kyselyFor(db)
    .selectFrom("worktrees")
    .selectAll()
    .where("path", "=", worktreePath)
    .orderBy("created_at", "desc")
    .limit(1);
  const row = executeSqliteQuerySync(db, query).rows[0];
  return row ? rowToRecord(row) : undefined;
}

export function insertRegistryWorktree(
  env: NodeJS.ProcessEnv,
  record: ManagedWorktreeRecord,
): void {
  const db = dbFor(env);
  runOpenClawStateWriteTransaction(() => {
    executeSqliteQuerySync(db, kyselyFor(db).insertInto("worktrees").values(recordToRow(record)));
  });
}

export function updateRegistryWorktree(
  env: NodeJS.ProcessEnv,
  id: string,
  patch: Partial<Pick<ManagedWorktreeRecord, "lastActiveAt" | "removedAt" | "snapshotRef">>,
): void {
  const db = dbFor(env);
  const values: Partial<WorktreeRow> = {};
  if (patch.lastActiveAt !== undefined) {
    values.last_active_at = patch.lastActiveAt;
  }
  if ("removedAt" in patch) {
    values.removed_at = patch.removedAt ?? null;
  }
  if ("snapshotRef" in patch) {
    values.snapshot_ref = patch.snapshotRef ?? null;
  }
  runOpenClawStateWriteTransaction(() => {
    executeSqliteQuerySync(
      db,
      kyselyFor(db).updateTable("worktrees").set(values).where("id", "=", id),
    );
  });
}

export function deleteRegistryWorktree(env: NodeJS.ProcessEnv, id: string): void {
  const db = dbFor(env);
  runOpenClawStateWriteTransaction(() => {
    executeSqliteQuerySync(db, kyselyFor(db).deleteFrom("worktrees").where("id", "=", id));
  });
}
