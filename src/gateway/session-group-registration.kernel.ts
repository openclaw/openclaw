import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
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
      const kysely = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "session_groups">>(db);
      const names = executeSqliteQuerySync(
        db,
        kysely.selectFrom("session_groups").select("name"),
      ).rows.map((row) => row.name);
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: { names } });
      if (hasSessionGroup(db, name)) {
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return false;
      }
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
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return true;
    },
    { database, path: database.path, env },
  );
}
