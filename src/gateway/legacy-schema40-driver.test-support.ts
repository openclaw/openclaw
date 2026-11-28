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

function assertSupportedStateSchemaVersion(
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

const command = new Promise<{ databasePath: string; runningRoot: string }>((resolve) => {
  process.once("message", resolve);
});
process.send?.({ ready: true });
const { databasePath, runningRoot } = await command;
const { settleGitReleaseTrial } = await import("../infra/git-release.js");
await settleGitReleaseTrial(runningRoot);
const database = new DatabaseSync(databasePath, { readOnly: true });
try {
  assertSupportedStateSchemaVersion(database, databasePath);
} finally {
  database.close();
}
process.disconnect?.();
