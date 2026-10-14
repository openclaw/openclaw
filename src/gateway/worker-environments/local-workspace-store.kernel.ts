import type { Selectable, Updateable } from "kysely";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { getOpenClawStateFeatureSchemaSql } from "../../state/openclaw-state-feature-schema.js";
import { localWorkspacePublication } from "./local-workspace-publication.js";

const table = "local_workspace_projections";
export type LocalWorkspaceProjection = Selectable<DB[typeof table]>;
export type LocalWorkspaceMutation =
  | { kind: "create"; row: Omit<LocalWorkspaceProjection, "revision"> }
  | { kind: "update"; revision: number; patch: Updateable<DB[typeof table]> }
  | { kind: "delete"; revision: number };
const query = (db: EngineConnection) => getNodeSqliteKysely<Pick<DB, typeof table>>(db);

export function readLocalWorkspaceProjectionInDatabase(db: EngineConnection, id: string) {
  return tableExists(db, table)
    ? executeSqliteQueryTakeFirstSync(
        db,
        query(db).selectFrom(table).selectAll().where("worktree_id", "=", id),
      )
    : undefined;
}

export function hasLocalWorkspaceProjectionInDatabase(db: EngineConnection, id: string): boolean {
  return (
    tableExists(db, table) &&
    executeSqliteQueryTakeFirstSync(
      db,
      query(db).selectFrom(table).select("worktree_id").where("worktree_id", "=", id),
    ) !== undefined
  );
}

export function mutateLocalWorkspaceProjection(
  db: EngineConnection,
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
      db.exec(getOpenClawStateFeatureSchemaSql(table)); // sqlite-allow-raw -- Canonical first-use schema admission.
    }
    const created = executeSqliteQueryTakeFirstSync(
      db,
      query(db)
        .insertInto(table)
        .values({ ...mutation.row, revision: 0 })
        .returningAll(),
    );
    if (created) {
      localWorkspacePublication.stagePostimages(db, [created]);
    }
    return created;
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
    localWorkspacePublication.stageDeletions(db, [id]);
    return undefined;
  }
  const updated = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .updateTable(table)
      .set({ ...mutation.patch, worktree_id: id, revision: current.revision + 1 })
      .where("worktree_id", "=", id)
      .returningAll(),
  );
  if (updated) {
    localWorkspacePublication.stagePostimages(db, [updated]);
  }
  return updated;
}

export const localWorkspaceReadOperations = {
  "localWorkspace.exists": (input: { id: string }, db: EngineConnection) => ({
    type: "localWorkspace.exists" as const,
    exists: hasLocalWorkspaceProjectionInDatabase(db, input.id),
  }),
  "localWorkspace.get": (input: { id: string }, db: EngineConnection) => ({
    type: "localWorkspace.get" as const,
    row: readLocalWorkspaceProjectionInDatabase(db, input.id),
  }),
};
