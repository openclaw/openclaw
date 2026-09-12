import type { DatabaseSync } from "node:sqlite";
import {
  readExistingAgentSchemaMeta,
  type ExistingAgentSchemaMeta,
} from "../state/openclaw-agent-db-metadata.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "./sqlite-transaction.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import { configureSqliteReadOnlyPragmas } from "./sqlite-wal.js";

export type SqliteSchemaHeader = {
  userVersion: number;
  writerAppVersion?: string;
  agentSchemaMeta?: ExistingAgentSchemaMeta | null;
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

/** Read version and requested ownership facts from one fresh transaction, including WAL. */
export function readSqliteSchemaHeader(
  database: DatabaseSync,
  agentSchemaVersionForOwnership?: number,
): SqliteSchemaHeader {
  configureSqliteReadOnlyPragmas(database);
  return runSqliteDeferredTransactionSync(database, () => {
    const userVersion = readSqliteUserVersion(database);
    const writerAppVersion = readSqliteWriterAppVersion(database);
    return {
      userVersion,
      ...(writerAppVersion ? { writerAppVersion } : {}),
      // A newer schema may have a different metadata contract; its version alone refuses admission.
      ...(agentSchemaVersionForOwnership !== undefined &&
      userVersion <= agentSchemaVersionForOwnership
        ? { agentSchemaMeta: readExistingAgentSchemaMeta(database) }
        : {}),
    };
  });
}
