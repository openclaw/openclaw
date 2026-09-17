import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";

/** The caller owns the transaction containing lookup, position allocation, and insertion. */
export function registerSessionGroupInDatabase(db: DatabaseSync, name: string): boolean {
  const kysely = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "session_groups">>(db);
  const existing = executeSqliteQuerySync(
    db,
    kysely.selectFrom("session_groups").select("name").where("name", "=", name).limit(1),
  ).rows[0];
  if (existing) {
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
  return true;
}
