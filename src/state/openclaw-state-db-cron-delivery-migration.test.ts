import { copyFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ensureCronRunReceiptSchema } from "../cron/store/run-receipt-store.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { runSqliteSchemaReadSnapshotSync } from "../infra/sqlite-pinned-read-snapshot.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { requireNativeSqliteDatabase as nativeDatabase } from "../test-utils/native-sqlite.js";
import { preflightOpenClawDatabaseSchemas } from "./openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION as SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { expectRow, expectRows } from "./openclaw-state-db-fixtures.test-support.js";
import { openOpenClawStateReadOnlyLocation } from "./openclaw-state-db-read-connection.js";
import { readStateSchemaContentVersion as readVersion } from "./openclaw-state-db-schema-version.js";
import {
  closeOpenClawStateDatabaseForTest as closeState,
  openOpenClawStateDatabase as openState,
  repairOpenClawStateDatabaseSchema as repairSchema,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeState();
  vi.restoreAllMocks();
});

function observeReads<T>(run: (queries: string[]) => T): T {
  const reads = observeSqliteReadSql(StatementSync.prototype);
  try {
    return run(reads.queries);
  } finally {
    reads.restore();
  }
}

function expectReceipt(db: EngineConnection, expected: Record<string, string>) {
  expectRows(db, `SELECT ${Object.keys(expected).join(", ")} FROM cron_run_receipts`, [expected]);
}

function legacyReceiptDatabase() {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("cron-delivery-migration-") } };
  const database = openState(options);
  ensureCronRunReceiptSchema(database.db);
  const databasePath = database.path;
  closeState();
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    ALTER TABLE cron_run_receipts DROP COLUMN delivery_attempt_state;
    INSERT INTO cron_run_receipts (
      cursor_id, receipt_id, store_key, job_id, config_revision, agent_id, status,
      owner_pid, owner_start_time, started_at_ms
    ) VALUES (1, 'legacy-receipt', '/fixture/cron', 'legacy-job', 'revision', 'main', 'running', 123, 1, 2);
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
    const reader = openOpenClawStateReadOnlyLocation(databasePath, databasePath);
    const { db } = reader.database;
    try {
      const migrateWhileReading = () => {
        expectRow(db, "SELECT receipt_id FROM cron_run_receipts", {
          receipt_id: "legacy-receipt",
        });
        expect(readVersion(db)).toBe(19);
        const writer = openState(options);
        expect(readVersion(writer.db)).toBe(SCHEMA_VERSION);
        observeReads((queries) => {
          expect(readVersion(db)).toBe(19);
          // Managed reads qualify the retained catalog once after sibling DDL.
          const qualificationQueries =
            kind === "managed transaction"
              ? [
                  "PRAGMA schema_version",
                  "PRAGMA user_version",
                  "SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE type IN ('table', 'view', 'index', 'trigger')",
                  'select "value_json" from "config_machine_state" where "state_key" = ?',
                ]
              : [];
          expect(queries).toEqual(qualificationQueries);
          expect(readVersion(db)).toBe(19);
          expect(queries).toEqual(qualificationQueries);
        });
        expect(() => db.prepare("SELECT delivery_attempt_state FROM cron_run_receipts")).toThrow(
          /no such column/iu,
        );
      };
      if (kind === "managed transaction") {
        runSqliteDeferredTransactionSync(db, migrateWhileReading);
      } else {
        runSqliteSchemaReadSnapshotSync(nativeDatabase(db), migrateWhileReading);
      }
      observeReads((queries) => {
        expect(readVersion(db)).toBe(SCHEMA_VERSION);
        expect(queries).toEqual([]);
      });
      expectReceipt(db, { delivery_attempt_state: "unknown" });
    } finally {
      reader.close();
    }
  },
);

it.each(["runtime open", "doctor repair"] as const)(
  "%s preserves legacy receipt uncertainty and refuses a schema-19 downgrade",
  async (entry) => {
    const { options } = legacyReceiptDatabase();
    const database = observeReads((queries) => {
      if (entry === "doctor repair") {
        expect(repairSchema(options).warnings).toEqual([]);
      }
      const opened = openState(options);
      const integrityChecks = queries.filter((sql) => /^PRAGMA integrity_check\s*;?$/iu.test(sql));
      expect(integrityChecks).toHaveLength(entry === "runtime open" ? 1 : 0);
      if (entry === "doctor repair") {
        expect(queries).toContain("PRAGMA quick_check;");
      }
      return opened;
    });
    const { db } = database;
    expectReceipt(db, {
      receipt_id: "legacy-receipt",
      status: "running",
      delivery_attempt_state: "unknown",
    });
    expectRow(db, "PRAGMA user_version", { user_version: SCHEMA_VERSION });
    expectRow(db, "PRAGMA integrity_check", { integrity_check: "ok" });
    db.exec("UPDATE cron_run_receipts SET delivery_attempt_state = 'started'");
    // Reuse remains valid while a sibling is live; final close requires readmission.
    const survivingReader = openOpenClawStateReadOnlyLocation(database.path, database.path);
    closeState();
    // Final close retires admission; the cold reopen precedes the warm-borrow observation.
    openState(options);
    try {
      observeReads((queries) => {
        expectReceipt(openState(options).db, { delivery_attempt_state: "started" });
        expect(
          queries.filter((sql) =>
            /(?:sqlite_(?:schema|master)|pragma_(?:table|index|foreign_key)|\bPRAGMA\s+(?:user_version|schema_version|integrity_check|quick_check|foreign_key_check|table_info|table_xinfo|index_list|index_info|index_xinfo)\b|\bFROM\s+"?schema_meta\b|state\.schema\.contentVersion)/iu.test(
              sql,
            ),
          ),
        ).toEqual([]);
      });
    } finally {
      survivingReader.close();
    }
    closeState();
    const preflight = await preflightOpenClawDatabaseSchemas({
      env: options.env,
      scope: "state",
      supportedVersions: { state: 19, agent: 23 },
    });
    expect(preflight.incompatible).toMatchObject([
      { kind: "state", foundVersion: SCHEMA_VERSION, supportedVersion: 19 },
    ]);
  },
);

it("rolls receipt migration back with schema publication failure", () => {
  const { options, databasePath } = legacyReceiptDatabase();
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TRIGGER refuse_schema_publication BEFORE UPDATE ON schema_meta
    BEGIN SELECT RAISE(ABORT, 'fixture publication refusal'); END;`);
  legacy.close();
  expect(() => openState(options)).toThrow("fixture publication refusal");
  using after = new DatabaseSync(databasePath, { readOnly: true });
  expectRow(after, "PRAGMA user_version", { user_version: 19 });
  expectReceipt(after, { receipt_id: "legacy-receipt", status: "running" });
  expectRow(
    after,
    "SELECT 1 FROM pragma_table_info('cron_run_receipts') WHERE name = 'delivery_attempt_state'",
    undefined,
  );
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
      store_key TEXT NOT NULL, job_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      schedule_kind TEXT NOT NULL DEFAULT 'manual',
      payload_kind TEXT NOT NULL DEFAULT 'message',
      delivery_thread_id TEXT, job_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (store_key, job_id)
    );
  `);
  db.prepare(
    "INSERT INTO cron_jobs (store_key, job_id, job_json, updated_at) VALUES (?, ?, ?, ?)",
  ).run(path.join(stateDir, "cron", "jobs.json"), "legacy-job", jobJson, 456);
  db.prepare("INSERT INTO cron_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
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

  const { db: migrated } = openState({ env: { OPENCLAW_STATE_DIR: stateDir } });

  expectRow(
    migrated,
    "SELECT name, enabled, payload_kind, agent_id, job_json FROM cron_jobs WHERE job_id = ?",
    {
      enabled: 1,
      agent_id: "agent-a",
      name: "Legacy job",
      payload_kind: "agentTurn",
      job_json: jobJson,
    },
    "legacy-job",
  );
  expectRow(
    migrated,
    `SELECT json_extract(job_json, '$.delivery.threadId') AS delivery_thread_id
           FROM cron_jobs
          WHERE job_id = ?`,
    { delivery_thread_id: 1008013 },
    "already-projected-job",
  );
});
