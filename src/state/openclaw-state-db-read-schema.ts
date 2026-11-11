import { requireNativeDatabaseFile } from "../infra/database-engine/physical-facts.js";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import type { SqliteSchemaErrorContext } from "../infra/sqlite-user-version.js";
import { getSqliteWorkerStateIntegrityAdmission } from "../infra/sqlite-worker-state-context.js";
import { assertExistingOpenClawStateRuntimeSchema } from "./openclaw-state-db-existing-schema.js";
import type { OpenClawStateIntegrityPolicy } from "./openclaw-state-db-integrity-admission.js";
import {
  assertSupportedStateSchemaVersion,
  type StateSchemaContentVersionRowReader,
} from "./openclaw-state-db-schema-version.js";

export function assertStateReadSchemaForPolicy(
  database: EngineConnection,
  pathname: string,
  existingSchema: boolean,
  integrityPolicy?: OpenClawStateIntegrityPolicy,
  readContentVersionRow?: StateSchemaContentVersionRowReader,
  context: SqliteSchemaErrorContext = "runtime",
): void {
  if (isPostgresSqlConnection(database)) {
    if (integrityPolicy !== undefined) {
      requireNativeDatabaseFile("postgres", "integrity");
    }
    assertSupportedStateSchemaVersion(
      database,
      pathname,
      undefined,
      readContentVersionRow,
      context,
    );
    return;
  }
  if (existingSchema) {
    assertExistingOpenClawStateRuntimeSchema(
      database,
      pathname,
      getSqliteWorkerStateIntegrityAdmission(),
      integrityPolicy,
      context,
    );
  } else {
    assertSupportedStateSchemaVersion(
      database,
      pathname,
      undefined,
      readContentVersionRow,
      context,
    );
  }
}
