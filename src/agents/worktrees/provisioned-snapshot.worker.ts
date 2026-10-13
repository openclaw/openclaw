import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";

export function writeProvisionedSnapshotInDatabase(
  db: DatabaseSync,
  input: { worktreeId: string } & (
    | { kind: "reset" }
    | { kind: "chunk"; path: string; chunkIndex: number; data: Uint8Array }
  ),
): void {
  const kysely = getNodeSqliteKysely<Pick<DB, "worktree_provisioned_file_chunks">>(db);
  if (input.kind === "reset") {
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("worktree_provisioned_file_chunks")
        .where("worktree_id", "=", input.worktreeId),
    );
  } else {
    executeSqliteQuerySync(
      db,
      kysely.insertInto("worktree_provisioned_file_chunks").values({
        worktree_id: input.worktreeId,
        path: input.path,
        chunk_index: input.chunkIndex,
        data: input.data,
      }),
    );
  }
}
