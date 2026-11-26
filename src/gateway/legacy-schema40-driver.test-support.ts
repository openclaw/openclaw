import { DatabaseSync } from "node:sqlite";
import type { EngineConnection } from "../infra/sql-connection.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
  readSqliteWriterAppVersion,
  type SqliteSchemaErrorContext,
} from "../infra/sqlite-user-version.js";
import {
  getStateSchemaVersionAdmission,
  type StateSchemaVersionFacts,
} from "../state/openclaw-state-db-admission.js";
import { normalizeOpenClawStateSchemaReadError } from "../state/openclaw-state-db-schema-migration-required.js";
import {
  readStateSchemaContentVersion,
  type StateSchemaContentVersionRowReader,
} from "../state/openclaw-state-db-schema-version.js";

const OPENCLAW_STATE_SCHEMA_VERSION = 40;

export function assertSupportedStateSchemaVersion(
  db: EngineConnection,
  pathname: string,
  prepared?: StateSchemaVersionFacts,
  readRow?: StateSchemaContentVersionRowReader,
  context: SqliteSchemaErrorContext = "runtime",
): number {
  if (isPostgresSqlConnection(db)) {
    return readStateSchemaContentVersion(db);
  }
  try {
    const userVersion =
      prepared?.userVersion ??
      getStateSchemaVersionAdmission(db)?.userVersion ??
      getAdmittedSqliteSchemaFacts(db)?.userVersion ??
      readSqliteUserVersion(db);
    const contentVersion =
      prepared?.contentVersion ??
      (userVersion > OPENCLAW_STATE_SCHEMA_VERSION
        ? userVersion
        : readStateSchemaContentVersion(db, userVersion, readRow, userVersion));
    if (contentVersion > OPENCLAW_STATE_SCHEMA_VERSION) {
      throw createNewerSqliteSchemaVersionError(
        "OpenClaw state database",
        pathname,
        contentVersion,
        OPENCLAW_STATE_SCHEMA_VERSION,
        readSqliteWriterAppVersion(db),
        context,
      );
    }
    return userVersion;
  } catch (error) {
    throw normalizeOpenClawStateSchemaReadError(error, pathname);
  }
}

process.once("message", (message: unknown) => {
  if (typeof message !== "string") {
    throw new Error("Expected the migrated state database path");
  }
  const database = new DatabaseSync(message, { readOnly: true });
  try {
    assertSupportedStateSchemaVersion(database, message);
  } finally {
    database.close();
  }
  process.disconnect?.();
});
process.send?.({ ready: true });
