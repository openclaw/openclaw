import type { DatabaseSync } from "node:sqlite";
import { CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { addPreCutoverClientCredentialTablesForTest } from "./openclaw-state-schema.test-support.js";

// Synthetic pre-v8 databases must not retain the current placement-only index.
export function markStateDatabaseVersion(database: DatabaseSync, version: number): void {
  if (
    version < CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION &&
    !database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'device_identities'").get()
  ) {
    addPreCutoverClientCredentialTablesForTest(database);
  }
  database.exec(`
    ${version < 8 ? "DROP INDEX IF EXISTS idx_worker_session_placements_environment;" : ""} PRAGMA user_version = ${version};
    UPDATE schema_meta SET schema_version = ${version} WHERE meta_key = 'primary';
  `);
}
