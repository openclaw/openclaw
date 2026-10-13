import type { DatabaseSync } from "node:sqlite";
import { getSqliteWorkerStateIntegrityAdmission } from "../infra/sqlite-worker-state-context.js";
import { assertExistingOpenClawStateRuntimeSchema } from "./openclaw-state-db-existing-schema.js";
import type { OpenClawStateIntegrityPolicy } from "./openclaw-state-db-integrity-admission.js";
import {
  assertSupportedStateSchemaVersion,
  type StateSchemaContentVersionRowReader,
} from "./openclaw-state-db-schema-version.js";

export function assertStateReadSchemaForPolicy(
  database: DatabaseSync,
  pathname: string,
  existingSchema: boolean,
  integrityPolicy?: OpenClawStateIntegrityPolicy,
  readContentVersionRow?: StateSchemaContentVersionRowReader,
): void {
  if (existingSchema) {
    assertExistingOpenClawStateRuntimeSchema(
      database,
      pathname,
      getSqliteWorkerStateIntegrityAdmission(),
      integrityPolicy,
    );
  } else {
    assertSupportedStateSchemaVersion(database, pathname, undefined, readContentVersionRow);
  }
}
