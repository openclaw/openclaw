import type { DatabaseSync } from "node:sqlite";
import type { Selectable, Updateable } from "kysely";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";

const table = "local_workspace_projections";
export type LocalWorkspaceProjection = Selectable<DB[typeof table]>;
const query = (db: DatabaseSync) => getNodeSqliteKysely<Pick<DB, typeof table>>(db);

/** Local executions share the reconciliation engine, never a remote placement identity. */
export function localWorkspaceStore(env: NodeJS.ProcessEnv = process.env) {
  const read = () => openOpenClawStateDatabase({ env }).db;
  const getFrom = (db: DatabaseSync, id: string) =>
    tableExists(db, table)
      ? executeSqliteQueryTakeFirstSync(
          db,
          query(db).selectFrom(table).selectAll().where("worktree_id", "=", id),
        )
      : undefined;
  const get = (id: string) => getFrom(read(), id);
  return {
    get,
    revision(id: string) {
      const db = read();
      return tableExists(db, table)
        ? executeSqliteQueryTakeFirstSync(
            db,
            query(db).selectFrom(table).select("revision").where("worktree_id", "=", id),
          )?.revision
        : undefined;
    },
    create(row: Omit<LocalWorkspaceProjection, "revision">, assertCurrent: () => void) {
      return runOpenClawStateWriteTransaction(
        ({ db }) => {
          // First-use additive DDL preserves the current numeric database version.
          db.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table)); // sqlite-allow-raw -- Canonical additive schema, ordinary operations use Kysely.
          assertCurrent();
          if (getFrom(db, row.worktree_id)) {
            throw new Error("Local workspace binding already exists");
          }
          return executeSqliteQueryTakeFirstSync(
            db,
            query(db)
              .insertInto(table)
              .values({ ...row, revision: 0 })
              .returningAll(),
          )!;
        },
        { env },
      );
    },
    update(
      row: LocalWorkspaceProjection,
      patch: Updateable<DB[typeof table]>,
      assertCurrent: () => void,
    ) {
      return runOpenClawStateWriteTransaction(
        ({ db }) => {
          assertCurrent();
          if (!Number.isSafeInteger(row.revision + 1)) {
            throw new Error("Local workspace revision exhausted");
          }
          const next = executeSqliteQueryTakeFirstSync(
            db,
            query(db)
              .updateTable(table)
              .set({ ...patch, revision: row.revision + 1 })
              .where("worktree_id", "=", row.worktree_id)
              .where("revision", "=", row.revision)
              .returningAll(),
          );
          if (!next) {
            throw new Error("Local workspace binding changed");
          }
          return next;
        },
        { env },
      );
    },
    delete(row: LocalWorkspaceProjection, assertCurrent: () => void) {
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          assertCurrent();
          if (row.pending_ref || row.journal_json) {
            throw new Error("Local workspace has unsettled edits");
          }
          const deleted = executeSqliteQueryTakeFirstSync(
            db,
            query(db)
              .deleteFrom(table)
              .where("worktree_id", "=", row.worktree_id)
              .where("revision", "=", row.revision)
              .returning("worktree_id"),
          );
          if (!deleted) {
            throw new Error("Local workspace binding changed");
          }
        },
        { env },
      );
    },
  };
}
