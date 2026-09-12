import { readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkNativeStateSchemaVersion } from "../../scripts/check-native-state-schema-version.mjs";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createNewerSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  readAgentRunTerminalReceipt,
  writeAgentRunTerminalReceipt,
} from "./agent-run-terminal-receipts.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { ensureAgentRunTerminalReceiptSchema } from "./openclaw-state-db-schema-additive.js";
import {
  closeOpenClawStateDatabaseForTest,
  detectOpenClawStateDatabaseSchemaMigrations,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const V17_SCHEMA_VERSION = 17;
const owner = { agentId: "agent-a", sessionKey: "agent:a:main", sessionId: "session-a" };
const terminalJson = JSON.stringify({ status: "ok", startedAt: 10, endedAt: 20 });

function testOptions(label: string) {
  return { env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make(label) } };
}

function readReceiptRows(db: DatabaseSync) {
  return db.prepare("SELECT rowid, * FROM agent_run_terminal_receipts ORDER BY run_id").all();
}

function readV17MigrationState(db: DatabaseSync) {
  const hasIndexOwnerGuard = db
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'terminal_receipt_index_owner_guard'",
    )
    .get();
  return {
    userVersion: db.prepare("PRAGMA user_version").get(),
    schemaVersion: db
      .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
      .get(),
    contentMarker: db
      .prepare("SELECT * FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'")
      .get(),
    schemaObjects: db
      .prepare(
        `SELECT type, name, tbl_name, sql
           FROM sqlite_schema
          WHERE tbl_name IN (
                  'agent_run_terminal_receipts',
                  'terminal_receipt_index_owner_guard'
                )
             OR name = 'agent_run_terminal_receipts_migration_v18'
          ORDER BY type, name`,
      )
      .all(),
    receiptRows: readReceiptRows(db),
    indexOwnerRows: hasIndexOwnerGuard
      ? db.prepare("SELECT * FROM terminal_receipt_index_owner_guard ORDER BY run_id").all()
      : [],
  };
}

function expectV17MigrationRefusalPreservesState(
  options: ReturnType<typeof testOptions>,
  databasePath: string,
  mismatch: RegExp,
): void {
  const beforeDb = openNodeSqliteDatabase(databasePath, { readOnly: true });
  let before: ReturnType<typeof readV17MigrationState>;
  try {
    before = readV17MigrationState(beforeDb);
  } finally {
    beforeDb.close();
  }

  try {
    expect(() => openOpenClawStateDatabase(options)).toThrow(mismatch);
  } finally {
    closeOpenClawStateDatabaseForTest();
  }

  const afterDb = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    expect(readV17MigrationState(afterDb)).toEqual(before);
  } finally {
    afterDb.close();
  }
}

function seedV17Database(options: ReturnType<typeof testOptions>, withTable: boolean) {
  const databasePath = openOpenClawStateDatabase(options).path;
  if (withTable) {
    runOpenClawStateWriteTransaction(({ db }) => {
      ensureAgentRunTerminalReceiptSchema(db);
      db.prepare(`INSERT INTO agent_run_terminal_receipts (
          run_id, agent_id, session_key, session_id, terminal_json, created_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        "r".repeat(256),
        owner.agentId,
        owner.sessionKey,
        owner.sessionId,
        terminalJson,
        10,
        20,
      );
    }, options);
  }
  closeOpenClawStateDatabaseForTest();
  const legacy = openNodeSqliteDatabase(databasePath);
  try {
    if (withTable) {
      legacy.exec(`
        DROP INDEX idx_agent_run_terminal_receipts_expiry;
        ALTER TABLE agent_run_terminal_receipts RENAME TO agent_run_terminal_receipts_v18_source;
        CREATE TABLE agent_run_terminal_receipts (
          run_id TEXT NOT NULL PRIMARY KEY CHECK (length(run_id) BETWEEN 1 AND 256),
          agent_id TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 128),
          session_key TEXT CHECK (session_key IS NULL OR length(session_key) BETWEEN 1 AND 1024),
          session_id TEXT CHECK (session_id IS NULL OR length(session_id) BETWEEN 1 AND 256),
          terminal_json TEXT NOT NULL CHECK (
            length(CAST(terminal_json AS BLOB)) BETWEEN 2 AND 65536
            AND json_valid(terminal_json)
            AND json_type(terminal_json) = 'object'
          ),
          created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
          expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms)
        ) STRICT;
        INSERT INTO agent_run_terminal_receipts SELECT * FROM agent_run_terminal_receipts_v18_source;
        DROP TABLE agent_run_terminal_receipts_v18_source;
        CREATE INDEX idx_agent_run_terminal_receipts_expiry
          ON agent_run_terminal_receipts(expires_at_ms, created_at_ms, run_id);
      `);
    }
    legacy.exec(`
      PRAGMA user_version = ${V17_SCHEMA_VERSION};
      UPDATE schema_meta SET schema_version = ${V17_SCHEMA_VERSION} WHERE meta_key = 'primary';
      DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion';
    `);
    return {
      databasePath,
      beforeRows: withTable ? readReceiptRows(legacy) : [],
    };
  } finally {
    legacy.close();
  }
}

function expectCurrentMetadata(db: DatabaseSync): void {
  expect(db.prepare("PRAGMA user_version").get()).toEqual({
    user_version: OPENCLAW_STATE_SCHEMA_VERSION,
  });
  expect(
    db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
  ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
}

describe("state schema v17 to v18 terminal receipt migration", () => {
  it("preserves every receipt, rebuilds the expiry index, and admits opaque run IDs after restart", () => {
    const options = testOptions("openclaw-terminal-receipts-v18-present-");
    const { databasePath, beforeRows } = seedV17Database(options, true);

    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toContainEqual({
      kind: "terminal-receipt-run-id-v18",
      path: databasePath,
    });

    const { db } = openOpenClawStateDatabase(options);
    expectCurrentMetadata(db);
    expect(readReceiptRows(db)).toEqual(beforeRows);
    expect(db.prepare("PRAGMA index_info(idx_agent_run_terminal_receipts_expiry)").all()).toEqual([
      expect.objectContaining({ name: "expires_at_ms" }),
      expect.objectContaining({ name: "created_at_ms" }),
      expect.objectContaining({ name: "run_id" }),
    ]);
    expect(
      db
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'agent_run_terminal_receipts'",
        )
        .get(),
    ).toEqual(expect.objectContaining({ sql: expect.stringContaining("CHECK (run_id <> '')") }));

    const opaqueRunId = `opaque-${"x".repeat(300)}`;
    expect(
      writeAgentRunTerminalReceipt({ runId: opaqueRunId, owner, terminalJson, env: options.env }),
    ).toBe(true);
    expect(
      readAgentRunTerminalReceipt({ runId: opaqueRunId, owner, now: 11, env: options.env }),
    ).toMatchObject({
      runId: opaqueRunId,
    });

    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase(options).db;
    expectCurrentMetadata(reopened);
    expect(
      readAgentRunTerminalReceipt({ runId: opaqueRunId, owner, now: 11, env: options.env }),
    ).toMatchObject({
      runId: opaqueRunId,
    });
  });

  it("leaves an absent v17 receipt table absent until the first canonical v18 write", () => {
    const options = testOptions("openclaw-terminal-receipts-v18-absent-");
    seedV17Database(options, false);

    const { db } = openOpenClawStateDatabase(options);
    expectCurrentMetadata(db);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'agent_run_terminal_receipts'",
        )
        .get(),
    ).toBeUndefined();

    expect(
      writeAgentRunTerminalReceipt({
        runId: "created-lazily",
        owner,
        terminalJson,
        env: options.env,
      }),
    ).toBe(true);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'agent_run_terminal_receipts'",
        )
        .get(),
    ).toEqual({ name: "agent_run_terminal_receipts" });
  });

  it("refuses a populated additive v17 column before rebuilding any receipt state", () => {
    const options = testOptions("openclaw-terminal-receipts-v18-extra-column-");
    const { databasePath } = seedV17Database(options, true);
    const legacy = openNodeSqliteDatabase(databasePath);
    try {
      legacy.exec("ALTER TABLE agent_run_terminal_receipts ADD COLUMN legacy_note TEXT;");
      legacy
        .prepare("UPDATE agent_run_terminal_receipts SET legacy_note = ?")
        .run("operator data must survive");
    } finally {
      legacy.close();
    }

    expectV17MigrationRefusalPreservesState(
      options,
      databasePath,
      /column definitions differ for agent_run_terminal_receipts[\s\S]*openclaw doctor --fix/u,
    );
  });

  it("refuses changed v17 constraints before rebuilding any receipt state", () => {
    const options = testOptions("openclaw-terminal-receipts-v18-constraint-drift-");
    const { databasePath } = seedV17Database(options, true);
    const legacy = openNodeSqliteDatabase(databasePath);
    try {
      legacy.exec(`
        DROP INDEX idx_agent_run_terminal_receipts_expiry;
        ALTER TABLE agent_run_terminal_receipts RENAME TO agent_run_terminal_receipts_source;
        CREATE TABLE agent_run_terminal_receipts (
          run_id TEXT NOT NULL PRIMARY KEY CHECK (length(run_id) BETWEEN 1 AND 256),
          agent_id TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 128),
          session_key TEXT CHECK (session_key IS NULL OR length(session_key) BETWEEN 1 AND 1024),
          session_id TEXT CHECK (session_id IS NULL OR length(session_id) BETWEEN 1 AND 256),
          terminal_json TEXT NOT NULL CHECK (
            length(CAST(terminal_json AS BLOB)) BETWEEN 2 AND 65536
            AND json_valid(terminal_json)
            AND json_type(terminal_json) = 'object'
          ),
          created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= -1),
          expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms)
        ) STRICT;
        INSERT INTO agent_run_terminal_receipts SELECT * FROM agent_run_terminal_receipts_source;
        DROP TABLE agent_run_terminal_receipts_source;
        CREATE INDEX idx_agent_run_terminal_receipts_expiry
          ON agent_run_terminal_receipts(expires_at_ms, created_at_ms, run_id);
      `);
    } finally {
      legacy.close();
    }

    expectV17MigrationRefusalPreservesState(
      options,
      databasePath,
      /column definitions differ for agent_run_terminal_receipts[\s\S]*openclaw doctor --fix/u,
    );
  });

  it("refuses the canonical expiry index name when another table owns it", () => {
    const options = testOptions("openclaw-terminal-receipts-v18-index-owner-");
    const { databasePath } = seedV17Database(options, true);
    const legacy = openNodeSqliteDatabase(databasePath);
    try {
      legacy.exec(`
        DROP INDEX idx_agent_run_terminal_receipts_expiry;
        CREATE TABLE terminal_receipt_index_owner_guard (
          run_id TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL
        ) STRICT;
        INSERT INTO terminal_receipt_index_owner_guard VALUES ('guard', 1, 2);
        CREATE INDEX idx_agent_run_terminal_receipts_expiry
          ON terminal_receipt_index_owner_guard(expires_at_ms, created_at_ms, run_id);
      `);
    } finally {
      legacy.close();
    }

    expectV17MigrationRefusalPreservesState(
      options,
      databasePath,
      /missing or drifted index idx_agent_run_terminal_receipts_expiry[\s\S]*openclaw doctor --fix/u,
    );
  });

  it("rolls back the rebuild, index, rows, and version markers when publication fails", () => {
    const options = testOptions("openclaw-terminal-receipts-v18-rollback-");
    const { databasePath, beforeRows } = seedV17Database(options, true);
    const failing = openNodeSqliteDatabase(databasePath);
    try {
      failing.exec(`CREATE TRIGGER reject_v18_publication BEFORE UPDATE ON schema_meta
        BEGIN SELECT RAISE(ABORT, 'v18 publication rejected'); END;`);
    } finally {
      failing.close();
    }

    expect(() => openOpenClawStateDatabase(options)).toThrow(/v18 publication rejected/u);
    const preserved = openNodeSqliteDatabase(databasePath, { readOnly: true });
    try {
      expect(preserved.prepare("PRAGMA user_version").get()).toEqual({ user_version: 17 });
      expect(readReceiptRows(preserved)).toEqual(beforeRows);
      expect(
        preserved
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'agent_run_terminal_receipts'",
          )
          .get(),
      ).toEqual(
        expect.objectContaining({
          sql: expect.stringContaining("CHECK (length(run_id) BETWEEN 1 AND 256)"),
        }),
      );
      expect(
        preserved
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name = 'idx_agent_run_terminal_receipts_expiry'",
          )
          .get(),
      ).toEqual({ name: "idx_agent_run_terminal_receipts_expiry" });
      expect(
        preserved
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name = 'agent_run_terminal_receipts_migration_v18'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      preserved.close();
    }
  });

  it("publishes complete TypeScript, package, and native schema version metadata", () => {
    expect(OPENCLAW_STATE_SCHEMA_VERSION).toBe(18);
    const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
    const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      openclaw?: { schemaVersions?: { state?: unknown } };
    };
    expect(packageJson.openclaw?.schemaVersions?.state).toBe(18);
    const swift = readFileSync(
      path.join(
        root,
        "apps/shared/OpenClawKit/Sources/OpenClawNativeState/OpenClawNativeStateSQLite.swift",
      ),
      "utf8",
    );
    expect(swift).toMatch(/maximumSupportedSchemaVersion: Int64 = 18/u);
    expect(checkNativeStateSchemaVersion()).toBe(18);
  });

  it("makes the migrated database refuse a v17 downgrade with backup recovery guidance", () => {
    const options = testOptions("openclaw-terminal-receipts-v18-downgrade-");
    seedV17Database(options, true);
    const { db, path: databasePath } = openOpenClawStateDatabase(options);
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number };

    expect(() => {
      if (row.user_version > V17_SCHEMA_VERSION) {
        throw createNewerSqliteSchemaVersionError(
          "OpenClaw state database",
          databasePath,
          row.user_version,
          V17_SCHEMA_VERSION,
        );
      }
    }).toThrow(/uses newer schema version 18[\s\S]*restore your pre-update backup/u);
  });
});
