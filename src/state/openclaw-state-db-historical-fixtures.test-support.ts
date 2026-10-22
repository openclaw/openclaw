import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { sha256Hex as sha256 } from "@openclaw/normalization-core/node-crypto";
import { CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { addPreCutoverClientCredentialTablesForTest } from "./openclaw-state-schema.test-support.js";

const V2026_7_1_2_STATE_FIXTURE_URL = new URL(
  "../../test/fixtures/sqlite/openclaw-state-v2026.7.1-2.sqlite.gz",
  import.meta.url,
);

export function materializeV2026_7_1_2StateDatabase(stateDir: string) {
  const compressed = fs.readFileSync(V2026_7_1_2_STATE_FIXTURE_URL);
  const raw = gunzipSync(compressed);
  const databasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.writeFileSync(databasePath, raw);
  return {
    compressedSha256: sha256(compressed),
    databasePath,
    rawSha256: sha256(raw),
  };
}

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
