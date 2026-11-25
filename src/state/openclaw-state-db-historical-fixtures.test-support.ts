import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { sha256Hex as sha256 } from "@openclaw/normalization-core/node-crypto";
import { expect } from "vitest";
import type { SqlConnection } from "../infra/sql-connection.js";
import { CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  restorePreTemplateStateIdentifiersForTest,
} from "./openclaw-state-schema.test-support.js";

export function downgradeWorkerPlacementsToV7(db: DatabaseSync): void {
  restorePreTemplateStateIdentifiersForTest(db);
  addPreCutoverClientCredentialTablesForTest(db);
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'worker_session_placements'",
    )
    .get() as { sql?: unknown } | undefined;
  if (typeof row?.sql !== "string") {
    throw new Error("missing worker_session_placements table SQL");
  }
  const v8LocalClaim = `(turn_claim_owner IS 'local' AND (\n      state IN ('local', 'requested', 'failed')\n      OR (state IN ('active', 'draining') AND execution_mode IS 'remote-exec')\n    ))`;
  const v7Create = row.sql
    .replace("CREATE TABLE worker_session_placements", "CREATE TABLE worker_session_placements_v7")
    .replace(
      "\n  execution_mode TEXT CHECK (execution_mode IN ('worker-turn', 'remote-exec')),",
      "",
    )
    .replace(
      v8LocalClaim,
      `(turn_claim_owner IS 'local' AND state IN ('local', 'requested', 'failed'))`,
    )
    .replace("\n      AND (execution_mode IS NULL OR execution_mode IS 'worker-turn')", "");
  if (v7Create.includes("execution_mode")) {
    throw new Error("failed to derive v7 worker placement schema");
  }
  const columns = (
    db.prepare("PRAGMA table_xinfo(worker_session_placements)").all() as Array<{
      hidden: number;
      name: string;
    }>
  )
    .filter((column) => column.hidden === 0 && column.name !== "execution_mode")
    .map((column) => `"${column.name}"`)
    .join(", ");
  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      ${v7Create};
      INSERT INTO worker_session_placements_v7 (${columns})
        SELECT ${columns} FROM worker_session_placements;
      DROP TABLE worker_session_placements;
      ALTER TABLE worker_session_placements_v7 RENAME TO worker_session_placements;
      CREATE INDEX idx_worker_session_placements_session_key
        ON worker_session_placements(agent_id, session_key);
      CREATE INDEX idx_worker_session_placements_reconcile
        ON worker_session_placements(updated_at_ms, session_id);
      PRAGMA user_version = 7;
      UPDATE schema_meta SET schema_version = 7 WHERE meta_key = 'primary';
      COMMIT;
    `);
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

const V2026_7_1_2_STATE_FIXTURE_URL = new URL(
  "../../test/fixtures/sqlite/openclaw-state-v2026.7.1-2.sqlite.gz",
  import.meta.url,
);

export const V2026_7_1_2_STATE_MIGRATION_CHANGES = [
  "Discarded retired shared-state commitments rows, table, and indexes",
  "Retired six dead shared-state tables (v10)",
  "Retired legacy skill curator lifecycle and proposal origin-run tables",
  "Folded singleton state tables into config_machine_state (v12)",
  "Migrated shared state audit event ledger → versioned message lifecycle schema",
  "Derived meeting transcript selectors and bounded delivery retention columns (v21)",
  "Promoted portable ACP resume keys and cursor identities (v22)",
  "Consolidated shared state tables (v13)",
  "Qualified historical cron creator attribution as unknown (v14)",
  "Removed redundant conversation binding target projections (v15)",
  "Replaced retained task indexes with ordered cron history indexes (v24)",
  "Removed redundant replay and skill indexes and narrowed the lease-owner index (v27)",
  "Introduced durable default cron partition selection (v34)",
  "Migrated shared state tables to SQLite STRICT typing (46)",
];

export function expectV2026_7_1_2CronHistoryPreserved(database: SqlConnection): void {
  const row = database
    .prepare(
      "SELECT task_id, runtime, source_id, status, ended_at, detail_json FROM task_runs WHERE runtime = 'cron' AND source_id = 'fixture-cron'",
    )
    .get();
  const { detail_json, ...task } = row ?? {};
  expect(task).toEqual({
    task_id: "cron-runlog-import:fixture-cron:1500:1",
    runtime: "cron",
    source_id: "fixture-cron",
    status: "succeeded",
    ended_at: 1500,
  });
  expect(JSON.parse(String(detail_json))).toMatchObject({
    kind: "cron-run",
    storeKey: "/fixture/state/cron/jobs.json",
    runId: "fixture-cron-run",
  });
  expect(
    database
      .prepare(
        "SELECT value_json FROM config_machine_state WHERE state_key = 'cron.defaultStoreKey'",
      )
      .get(),
  ).toEqual({ value_json: JSON.stringify("/fixture/state/cron/jobs.json") });
}

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
  if (version < 36) {
    restorePreTemplateStateIdentifiersForTest(database);
  }
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

/** Shared expected tail for historical fixtures; independent of production migration discovery. */
export function expectedStateMigrationsFromV27(pathname: string) {
  return [
    "state-write-indexes-v27",
    "github-publication-draft-v28",
    "local-client-credentials-v29",
    "automation-policy-fence-v30",
    "local-workspace-manifests-v31",
    "local-workspace-cas-v35",
    "template-names-v36",
    "worker-resource-receipts-v37",
    "repository-disk-authority-v38",
  ].map((kind) => ({ kind, path: pathname }));
}
