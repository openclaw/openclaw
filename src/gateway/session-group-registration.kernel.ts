import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";

export function registerSessionGroupInDatabase(
  database: OpenClawStateDatabase,
  name: string,
  env: NodeJS.ProcessEnv,
): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "session_groups">>(db);
      const names = executeSqliteQuerySync(
        db,
        kysely.selectFrom("session_groups").select("name"),
      ).rows.map((row) => row.name);
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: { names } });
      if (names.includes(name)) {
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
