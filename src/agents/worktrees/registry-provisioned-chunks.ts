import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";

type ProvisionedDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "worktree_provisioned_file_chunks" | "worktrees"
>;

function databaseFor(env: NodeJS.ProcessEnv): DatabaseSync {
  return openOpenClawStateDatabase({ env }).db;
}

function kyselyFor(database: DatabaseSync) {
  return getNodeSqliteKysely<ProvisionedDatabase>(database);
}

export function clearRegistryWorktreeProvisionedChunks(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
): void {
  const database = databaseFor(env);
  runOpenClawStateWriteTransaction(() => {
    executeSqliteQuerySync(
      database,
      kyselyFor(database)
        .deleteFrom("worktree_provisioned_file_chunks")
        .where("worktree_id", "=", worktreeId),
    );
  });
}

export function insertRegistryWorktreeProvisionedChunk(
  env: NodeJS.ProcessEnv,
  params: { worktreeId: string; path: string; chunkIndex: number; data: Uint8Array },
): void {
  const database = databaseFor(env);
  runOpenClawStateWriteTransaction(() => {
    executeSqliteQuerySync(
      database,
      kyselyFor(database).insertInto("worktree_provisioned_file_chunks").values({
        worktree_id: params.worktreeId,
        path: params.path,
        chunk_index: params.chunkIndex,
        data: params.data,
      }),
    );
  });
}

export function getRegistryWorktreeProvisionedChunk(
  env: NodeJS.ProcessEnv,
  params: { worktreeId: string; path: string; chunkIndex: number },
): Uint8Array | undefined {
  const database = databaseFor(env);
  return executeSqliteQuerySync(
    database,
    kyselyFor(database)
      .selectFrom("worktree_provisioned_file_chunks")
      .select("data")
      .where("worktree_id", "=", params.worktreeId)
      .where("path", "=", params.path)
      .where("chunk_index", "=", params.chunkIndex),
  ).rows[0]?.data;
}

export function deleteRegistryWorktree(env: NodeJS.ProcessEnv, id: string): void {
  const database = databaseFor(env);
  runOpenClawStateWriteTransaction(() => {
    executeSqliteQuerySync(
      database,
      kyselyFor(database)
        .deleteFrom("worktree_provisioned_file_chunks")
        .where("worktree_id", "=", id),
    );
    executeSqliteQuerySync(
      database,
      kyselyFor(database).deleteFrom("worktrees").where("id", "=", id),
    );
  });
}
