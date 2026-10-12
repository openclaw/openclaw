import { copyFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ensureCronRunReceiptSchema } from "../cron/store/run-receipt-store.js";
import { runSqliteSchemaReadSnapshotSync } from "../infra/sqlite-pinned-read-snapshot.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { preflightOpenClawDatabaseSchemas } from "./openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  openOpenClawStateReadConnection,
  openOpenClawStateReadOnlyLocation,
} from "./openclaw-state-db-read-connection.js";
import { readStateSchemaContentVersion } from "./openclaw-state-db-schema-version.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

function legacyReceiptDatabase() {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("cron-delivery-migration-") } };
  const database = openOpenClawStateDatabase(options);
  ensureCronRunReceiptSchema(database.db);
  const databasePath = database.path;
  closeOpenClawStateDatabaseForTest();
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    ALTER TABLE cron_run_receipts DROP COLUMN delivery_attempt_state;
    INSERT INTO cron_run_receipts (
      receipt_id, store_key, job_id, config_revision, agent_id, status,
      owner_pid, owner_start_time, started_at_ms
    ) VALUES ('legacy-receipt', '/fixture/cron', 'legacy-job', 'revision', 'main', 'running', 123, 1, 2);
    PRAGMA user_version = 19;
    UPDATE schema_meta SET schema_version = 19;
  `);
  legacy.close();
  // The fixture represents bytes created by a previous process, outside this load's admission.
  const replacement = `${databasePath}.legacy`;
  copyFileSync(databasePath, replacement);
  renameSync(replacement, databasePath);
  return { options, databasePath };
}

it.each(["managed transaction", "implicit snapshot"] as const)(
  "keeps a reader's %s version until the migrated catalog becomes visible",
  (kind) => {
    const { options, databasePath } = legacyReceiptDatabase();
    openOpenClawStateReadOnlyLocation(databasePath, databasePath).close();
    const reader = openOpenClawStateReadConnection(databasePath, databasePath);
    const { db } = reader.database;
    try {
      const migrateWhileReading = () => {
        expect(db.prepare("SELECT receipt_id FROM cron_run_receipts").get()).toEqual({
          receipt_id: "legacy-receipt",
        });
        const writer = openOpenClawStateDatabase(options);
        expect(readStateSchemaContentVersion(writer.db)).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
        const observation = observeSqliteReadSql(StatementSync.prototype);
        try {
          expect(readStateSchemaContentVersion(db)).toBe(19);
          expect(observation.queries).toEqual([]);
        } finally {
          observation.restore();
        }
        expect(() => db.prepare("SELECT delivery_attempt_state FROM cron_run_receipts")).toThrow(
          /no such column/iu,
        );
      };
      if (kind === "managed transaction") {
        runSqliteDeferredTransactionSync(db, migrateWhileReading);
      } else {
        runSqliteSchemaReadSnapshotSync(db, migrateWhileReading);
      }
      const observation = observeSqliteReadSql(StatementSync.prototype);
      try {
        expect(readStateSchemaContentVersion(db)).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
        expect(observation.queries).toEqual([]);
      } finally {
        observation.restore();
      }
      expect(db.prepare("SELECT delivery_attempt_state FROM cron_run_receipts").get()).toEqual({
        delivery_attempt_state: "unknown",
      });
    } finally {
      reader.close();
    }
  },
);

it.each(["runtime open", "doctor repair"] as const)(
  "%s preserves legacy receipt uncertainty and refuses a schema-19 downgrade",
  async (entry) => {
    const { options } = legacyReceiptDatabase();
    const migration = observeSqliteReadSql(StatementSync.prototype);
    let database: ReturnType<typeof openOpenClawStateDatabase>;
    try {
      if (entry === "doctor repair") {
        expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
      }
      database = openOpenClawStateDatabase(options);
      const integrityChecks = migration.queries.filter((sql) =>
        /^PRAGMA integrity_check\s*;?$/iu.test(sql),
      );
      if (entry === "runtime open") {
        expect(integrityChecks).toHaveLength(1);
      } else {
        expect(integrityChecks.length).toBeGreaterThan(0);
      }
    } finally {
      migration.restore();
    }
    const { db } = database;
    expect(
      db.prepare("SELECT receipt_id, status, delivery_attempt_state FROM cron_run_receipts").all(),
    ).toEqual([
      { receipt_id: "legacy-receipt", status: "running", delivery_attempt_state: "unknown" },
    ]);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    db.exec("UPDATE cron_run_receipts SET delivery_attempt_state = 'started'");
    closeOpenClawStateDatabaseForTest();
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      expect(
        openOpenClawStateDatabase(options)
          .db.prepare("SELECT delivery_attempt_state FROM cron_run_receipts")
          .get(),
      ).toEqual({ delivery_attempt_state: "started" });
      expect(
        observation.queries.filter((sql) =>
          /(?:sqlite_(?:schema|master)|pragma_(?:table|index|foreign_key)|\bPRAGMA\s+(?:user_version|schema_version|integrity_check|quick_check|foreign_key_check|table_info|table_xinfo|index_list|index_info|index_xinfo)\b|\bFROM\s+"?schema_meta\b|state\.schema\.contentVersion)/iu.test(
            sql,
          ),
        ),
      ).toEqual([]);
    } finally {
      observation.restore();
    }
    closeOpenClawStateDatabaseForTest();
    const preflight = await preflightOpenClawDatabaseSchemas({
      env: options.env,
      scope: "state",
      supportedVersions: { state: 19, agent: 23 },
    });
    expect(preflight.incompatible).toEqual([
      expect.objectContaining({
        kind: "state",
        foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
        supportedVersion: 19,
      }),
    ]);
  },
);

it("rolls receipt migration back with schema publication failure", () => {
  const { options, databasePath } = legacyReceiptDatabase();
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TRIGGER refuse_schema_publication BEFORE UPDATE ON schema_meta
    BEGIN SELECT RAISE(ABORT, 'fixture publication refusal'); END;`);
  legacy.close();
  expect(() => openOpenClawStateDatabase(options)).toThrow("fixture publication refusal");
  const after = new DatabaseSync(databasePath, { readOnly: true });
  try {
    expect(after.prepare("PRAGMA user_version").get()).toEqual({ user_version: 19 });
    expect(after.prepare("SELECT receipt_id, status FROM cron_run_receipts").all()).toEqual([
      { receipt_id: "legacy-receipt", status: "running" },
    ]);
    expect(
      after
        .prepare(
          "SELECT 1 FROM pragma_table_info('cron_run_receipts') WHERE name = 'delivery_attempt_state'",
        )
        .get(),
    ).toBeUndefined();
  } finally {
    after.close();
  }
});

it("opens databases with early cron tables before creating cron indexes", () => {
  const stateDir = tempDirs.make("early-cron-migration-");
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  const jobJson = JSON.stringify({
    id: "legacy-job",
    name: "Legacy job",
    enabled: true,
    deleteAfterRun: true,
    createdAtMs: 123,
    updatedAtMs: 456,
    agentId: "agent-a",
    sessionKey: "agent:agent-a:main",
    schedule: { kind: "every", everyMs: 3_600_000, anchorMs: 0 },
    payload: { kind: "agentTurn", message: "hello", model: "anthropic/claude-sonnet-4-6" },
    delivery: {
      mode: "announce",
      channel: "telegram",
      to: "chat-1",
      accountId: "acct-1",
      bestEffort: true,
      failureDestination: { to: "https://example.invalid/hook" },
    },
    failureAlert: { mode: "announce", channel: "discord", to: "ops", after: 2 },
  });
  const projectedJobJson = JSON.stringify({ delivery: { threadId: 1008013 } });
  db.exec(`
    CREATE TABLE cron_jobs (
      store_key TEXT NOT NULL,
      job_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      schedule_kind TEXT NOT NULL DEFAULT 'manual',
      payload_kind TEXT NOT NULL DEFAULT 'message',
      delivery_thread_id TEXT,
      job_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (store_key, job_id)
    );
  `);
  db.prepare(
    `INSERT INTO cron_jobs (store_key, job_id, job_json, updated_at)
       VALUES (?, ?, ?, ?)`,
  ).run(path.join(stateDir, "cron", "jobs.json"), "legacy-job", jobJson, 456);
  db.prepare(
    `INSERT INTO cron_jobs (
       store_key, job_id, name, schedule_kind, payload_kind, delivery_thread_id, job_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    path.join(stateDir, "cron", "jobs.json"),
    "already-projected-job",
    "Already projected",
    "every",
    "agentTurn",
    null,
    projectedJobJson,
    456,
  );
  db.close();

  const database = openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: stateDir },
  });

  expect(
    database.db
      .prepare(
        `SELECT name, enabled, payload_kind, agent_id, job_json
           FROM cron_jobs
          WHERE job_id = ?`,
      )
      .get("legacy-job"),
  ).toEqual({
    enabled: 1,
    agent_id: "agent-a",
    name: "Legacy job",
    payload_kind: "agentTurn",
    job_json: jobJson,
  });
  expect(
    database.db
      .prepare(
        `SELECT json_extract(job_json, '$.delivery.threadId') AS delivery_thread_id
           FROM cron_jobs
          WHERE job_id = ?`,
      )
      .get("already-projected-job"),
  ).toEqual({ delivery_thread_id: 1008013 });
});
