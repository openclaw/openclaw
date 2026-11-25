import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  seedHistoricalPlacements,
  stateV21Schema,
} from "./openclaw-historical-imports.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  detectOpenClawStateDatabaseSchemaMigrations,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  restorePreTemplateStateIdentifiersForTest,
  withStateMigrationBackupForTest,
} from "./openclaw-state-schema.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseAsync);

function snapshot(db: DatabaseSync) {
  return {
    placements: db
      .prepare("SELECT rowid,* FROM worker_session_placements ORDER BY session_id")
      .all(),
    dependentCustody: db.prepare("SELECT * FROM historical_cleanup_custody").all(),
    leases: db.prepare("SELECT * FROM state_leases WHERE scope='fixture'").all(),
  };
}

function downgradeWorkerPlacementsToV7(db: DatabaseSync): void {
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

it("migrates v7 worker placement claims and missing terminal columns without losing rows", async () => {
  const options = { env: { OPENCLAW_STATE_DIR: dirs.make("historical-placement-v7-") } };
  const { path: databasePath } = openOpenClawStateDatabase(options);
  await closeOpenClawStateDatabaseAsync();
  {
    using legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      INSERT INTO worker_session_placements (
        session_id, agent_id, session_key, state, transition_generation, created_at_ms, updated_at_ms, state_changed_at_ms
      ) VALUES ('legacy-session', 'main', 'agent:main:legacy', 'local', 3, 1, 2, 2);
    `);
    downgradeWorkerPlacementsToV7(legacy);
    legacy.exec(`
      ALTER TABLE worker_session_placements DROP COLUMN terminal_at_ms;
      ALTER TABLE worker_session_placements DROP COLUMN terminal_reason;
      ALTER TABLE worker_session_placements DROP COLUMN confirmed_loss_recovery_json;
    `);
  }

  const migration = { kind: "worker-placement-execution-mode-v8", path: databasePath };
  expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toContainEqual(migration);
  await withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options));
  const { db } = openOpenClawStateDatabase(options);
  expect(db.prepare("PRAGMA user_version").get()).toEqual({
    user_version: OPENCLAW_STATE_SCHEMA_VERSION,
  });
  expect(
    db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
  ).toEqual({
    schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
  });
  expect(
    db
      .prepare(
        "SELECT session_id, transition_generation, execution_mode, confirmed_loss_recovery_json FROM worker_session_placements",
      )
      .get(),
  ).toEqual({
    session_id: "legacy-session",
    transition_generation: 3,
    execution_mode: null,
    confirmed_loss_recovery_json: null,
  });
  const columns = db.prepare("PRAGMA table_info(worker_session_placements)").all();
  expect(columns.map((column) => column.name).slice(-3)).toEqual([
    "terminal_reason",
    "terminal_at_ms",
    "confirmed_loss_recovery_json",
  ]);
  expect(detectOpenClawStateDatabaseSchemaMigrations(options)).not.toContainEqual(migration);
});

it.each([
  ["refuses a live worker claim without losing historical custody", "claim"],
  ["rolls back publication failure and retries without losing historical custody", "publication"],
] as const)("%s", async (_name, refusal) => {
  const root = dirs.make("historical-placement-");
  const pathname = path.join(root, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  const options = {
    path: pathname,
    env: { OPENCLAW_STATE_DIR: root },
    versionMigrationOnly: true,
  };
  using db = new DatabaseSync(pathname);
  db.exec(stateV21Schema());
  db.exec(
    "PRAGMA user_version=21; INSERT INTO schema_meta(meta_key,role,schema_version,created_at,updated_at) VALUES ('primary','global',21,1,1);",
  );
  seedHistoricalPlacements(db);
  db.exec(
    "CREATE TABLE historical_cleanup_custody (session_id TEXT PRIMARY KEY REFERENCES worker_session_placements(session_id) ON DELETE CASCADE, evidence TEXT NOT NULL); INSERT INTO historical_cleanup_custody VALUES ('placement-pending',' {\"custody\": 7} ');" +
      "INSERT INTO state_leases VALUES ('fixture','custody','fixture-owner',1900000000000,11,' {\"lease\": 7} ',1,2);",
  );
  db.exec(
    refusal === "claim"
      ? "UPDATE worker_session_placements SET turn_claim_owner='worker',turn_claim_id='pending-claim',turn_claim_run_id='pending-run',turn_claim_generation=7,turn_claim_owner_epoch=3 WHERE session_id='placement-pending'"
      : "CREATE TRIGGER refuse_publication BEFORE UPDATE ON schema_meta BEGIN SELECT RAISE(ABORT,'fixture publication refusal'); END;",
  );
  await withStateMigrationBackupForTest(options, () => {
    const before = snapshot(db);
    const shape = db
      .prepare("SELECT sql FROM sqlite_schema WHERE name='worker_session_placements'")
      .get();
    expect(repairOpenClawStateDatabaseSchema(options).warnings.join("\n")).toContain(
      refusal === "claim" ? "retains a worker turn claim" : "fixture publication refusal",
    );
    expect(snapshot(db)).toEqual(before);
    expect(
      db.prepare("SELECT sql FROM sqlite_schema WHERE name='worker_session_placements'").get(),
    ).toEqual(shape);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(21);
    expect(db.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version).toBe(21);
    if (refusal === "publication") {
      db.exec("DROP TRIGGER refuse_publication");
      expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
      const after = snapshot(db);
      expect(after).toEqual({ ...before, placements: expect.any(Array) });
      expect(after.placements).toHaveLength(before.placements.length);
      for (const [index, row] of before.placements.entries()) {
        const retained = { ...row, confirmed_loss_recovery_json: null };
        expect(after.placements[index]).toEqual(
          row.repository_preparation === "pending"
            ? {
                ...retained,
                state: "failed",
                recovery_error: expect.stringContaining(
                  "Historical repository preparation pending",
                ),
              }
            : retained,
        );
      }
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
      expect(db.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }
  });
});
