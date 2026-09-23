import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";

function hasSessionGroup(db: DatabaseSync, name: string): boolean {
  const kysely = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "session_groups">>(db);
  return Boolean(
    executeSqliteQuerySync(
      db,
      kysely.selectFrom("session_groups").select("name").where("name", "=", name).limit(1),
    ).rows[0],
  );
}

export function registerSessionGroupInDatabase(
  database: OpenClawStateDatabase,
  name: string,
  env: NodeJS.ProcessEnv,
): boolean {
  // Existing categories need no writer admission. Missing names must be checked
  // again after admission because another writer can register them in between.
  if (hasSessionGroup(database.db, name)) {
    return false;
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      if (hasSessionGroup(db, name)) {
        return false;
      }
      const kysely = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "session_groups">>(db);
      const maxRow = executeSqliteQuerySync(
        db,
        kysely.selectFrom("session_groups").select("position").orderBy("position", "desc").limit(1),
      ).rows[0];
      executeSqliteQuerySync(
        db,
        kysely.insertInto("session_groups").values({
          name,
          position: (maxRow?.position ?? -1) + 1,
          created_at: Date.now(),
        }),
      );
      return true;
    },
    { database, path: database.path, env },
  );
}
