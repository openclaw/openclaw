import type { DatabaseSync } from "node:sqlite";
import type { Selectable, Updateable } from "kysely";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";

const table = "local_workspace_projections";
export type LocalWorkspaceProjection = Selectable<DB[typeof table]>;
export type LocalWorkspaceMutation =
  | { kind: "create"; row: Omit<LocalWorkspaceProjection, "revision"> }
  | { kind: "update"; revision: number; patch: Updateable<DB[typeof table]> }
  | { kind: "delete"; revision: number };
const query = (db: DatabaseSync) => getNodeSqliteKysely<Pick<DB, typeof table>>(db);

export function readLocalWorkspaceProjectionInDatabase(db: DatabaseSync, id: string) {
  return tableExists(db, table)
    ? executeSqliteQueryTakeFirstSync(
        db,
        query(db).selectFrom(table).selectAll().where("worktree_id", "=", id),
      )
    : undefined;
}

export function hasLocalWorkspaceProjectionInDatabase(db: DatabaseSync, id: string): boolean {
  return (
    tableExists(db, table) &&
    executeSqliteQueryTakeFirstSync(
      db,
      query(db).selectFrom(table).select("worktree_id").where("worktree_id", "=", id),
    ) !== undefined
  );
}

export function mutateLocalWorkspaceProjection(
  db: DatabaseSync,
  id: string,
  mutation: LocalWorkspaceMutation,
) {
  // Mutation admission must not materialize manifests or recovery packs.
  const current = tableExists(db, table)
    ? executeSqliteQueryTakeFirstSync(
        db,
        query(db)
          .selectFrom(table)
          .select("revision")
          .$if(mutation.kind === "delete", (builder) =>
            builder.select((eb) =>
              eb
                .or([
                  eb(
                    eb.fn.coalesce(eb.fn<number>("octet_length", ["pending_ref"]), eb.val(0)),
                    ">",
                    0,
                  ),
                  eb(
                    eb.fn.coalesce(eb.fn<number>("octet_length", ["journal_json"]), eb.val(0)),
                    ">",
                    0,
                  ),
                ])
                .as("unsettled"),
            ),
          )
          .where("worktree_id", "=", id),
      )
    : undefined;
  if (mutation.kind === "create") {
    if (current || mutation.row.worktree_id !== id) {
      throw new Error("Local workspace binding already exists");
    }
    if (!tableExists(db, table)) {
      // First-use additive admission preserves the existing numeric schema version.
      db.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table)); // sqlite-allow-raw -- Canonical first-use schema admission.
    }
    return executeSqliteQueryTakeFirstSync(
      db,
      query(db)
        .insertInto(table)
        .values({ ...mutation.row, revision: 0 })
        .returningAll(),
    );
  }
  if (!current || current.revision !== mutation.revision) {
    throw new Error("Local workspace binding changed");
  }
  if (mutation.kind === "delete") {
    if (current.unsettled) {
      throw new Error("Local workspace has unsettled edits");
    }
    executeSqliteQueryTakeFirstSync(
      db,
      query(db).deleteFrom(table).where("worktree_id", "=", id).returning("worktree_id"),
    );
    return undefined;
  }
  if (!Number.isSafeInteger(current.revision + 1)) {
    throw new Error("Local workspace revision exhausted");
  }
  return executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .updateTable(table)
      .set({ ...mutation.patch, worktree_id: id, revision: current.revision + 1 })
      .where("worktree_id", "=", id)
      .returningAll(),
  );
}

export const localWorkspaceReadOperations = {
  "localWorkspace.exists": (input: { id: string }, db: DatabaseSync) => ({
    type: "localWorkspace.exists" as const,
    exists: hasLocalWorkspaceProjectionInDatabase(db, input.id),
  }),
  "localWorkspace.get": (input: { id: string }, db: DatabaseSync) => ({
    type: "localWorkspace.get" as const,
    row: readLocalWorkspaceProjectionInDatabase(db, input.id),
  }),
};
