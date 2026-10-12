import type { DatabaseSync } from "node:sqlite";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import { getSqliteWorkerStateIntegrityAdmission } from "../infra/sqlite-worker-state-context.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { assertExistingOpenClawStateRuntimeSchema } from "./openclaw-state-db-existing-schema.js";
import type { OpenClawStateIntegrityPolicy } from "./openclaw-state-db-integrity-admission.js";
import { normalizeOpenClawStateSchemaReadError } from "./openclaw-state-db-schema-migration-required.js";
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

export function admitStateReadSchemaFacts(database: DatabaseSync, pathname: string): void {
  try {
    admitSqliteSchema(database, (userVersion) =>
      assertSupportedStateSchemaVersion(database, pathname, {
        userVersion,
        contentVersion: userVersion,
      }),
    );
  } catch (error) {
    // An unreadable newer catalog must not be mistaken for a repair this build can perform.
    let version: number;
    try {
      version = readSqliteUserVersion(database);
    } catch {
      throw normalizeOpenClawStateSchemaReadError(error, pathname);
    }
    if (version > OPENCLAW_STATE_SCHEMA_VERSION) {
      throw createNewerSqliteSchemaVersionError(
        "OpenClaw state database",
        pathname,
        version,
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
    }
    throw normalizeOpenClawStateSchemaReadError(error, pathname);
  }
}
