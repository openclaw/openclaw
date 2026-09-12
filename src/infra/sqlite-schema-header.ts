import type { DatabaseSync } from "node:sqlite";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "./sqlite-transaction.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import { configureSqliteReadOnlyPragmas } from "./sqlite-wal.js";

export type SqliteSchemaHeader = {
  userVersion: number;
  writerAppVersion?: string;
};

export function readSqliteWriterAppVersion(database: DatabaseSync): string | undefined {
  try {
    // Schema metadata inspection also accepts older or newer metadata contracts.
    const row = executeSqliteQueryTakeFirstSync(
      database,
      getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "schema_meta">>(database)
        .selectFrom("schema_meta")
        .select("app_version")
        .where("meta_key", "=", "primary")
        .limit(1),
    );
    return typeof row?.app_version === "string" && row.app_version.length > 0
      ? row.app_version
      : undefined;
  } catch {
    return undefined;
  }
}

/** Read both metadata values from one fresh SQLite read transaction, including WAL. */
export function readSqliteSchemaHeader(database: DatabaseSync): SqliteSchemaHeader {
  configureSqliteReadOnlyPragmas(database);
  return runSqliteDeferredTransactionSync(database, () => {
    const userVersion = readSqliteUserVersion(database);
    const writerAppVersion = readSqliteWriterAppVersion(database);
    return { userVersion, ...(writerAppVersion ? { writerAppVersion } : {}) };
  });
}
