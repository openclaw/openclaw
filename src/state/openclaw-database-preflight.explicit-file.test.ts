import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { closeOpenClawAgentDatabasesForTest } from "./openclaw-agent-db.js";
import {
  assertOpenClawDatabasesReady,
  preflightOpenClawStateDatabasePath,
} from "./openclaw-database-preflight.js";
import { snapshotSourceFamily } from "./openclaw-database-preflight.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("explicit copied shared-state preflight", () => {
  function createExplicitStateDatabase(schemaSql = OPENCLAW_STATE_SCHEMA_SQL): string {
    const stateDir = tempDirs.make("openclaw-explicit-state-preflight-");
    const databasePath = path.join(stateDir, "candidate.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    try {
      // Match production bootstrap: one durable commit, not one per schema object.
      runSqliteImmediateTransactionSync(database, () => {
        database.exec(`${schemaSql}; PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
        database
          .prepare(
            `INSERT INTO schema_meta (
               meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
             ) VALUES ('primary', 'global', ?, NULL, NULL, 1, 1)`,
          )
          .run(OPENCLAW_STATE_SCHEMA_VERSION);
      });
    } finally {
      database.close();
    }
    return databasePath;
  }

  it("reports an exact current schema for one explicit copied database", async () => {
    const stateDir = tempDirs.make("openclaw-runtime-state-preflight-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawStateDatabase({ env });
    const databasePath = opened.path;
    expect(
      opened.db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'execution_identity_contexts'",
        )
        .get(),
    ).toBeUndefined();
    closeOpenClawStateDatabaseForTest();

    await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toEqual({
      schema: "openclaw.state-schema-preflight.v1",
      databasePath,
      targetVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      ownership: null,
      issues: [],
      status: "exact",
      requiresWrite: false,
    });
  });

  it("treats a supported persistent column definition as exact", async () => {
    const databasePath = createExplicitStateDatabase(
      OPENCLAW_STATE_SCHEMA_SQL.replace(
        "  kind TEXT NOT NULL,\n  sensitivity TEXT NOT NULL,",
        "  kind TEXT NOT NULL DEFAULT 'followup',\n  sensitivity TEXT NOT NULL,",
      ),
    );

    await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toEqual({
      schema: "openclaw.state-schema-preflight.v1",
      databasePath,
      targetVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      ownership: null,
      status: "exact",
      requiresWrite: false,
      issues: [],
    });
  });

  it("defers retired cron history in an explicit copied database without repair", async () => {
    const databasePath = createExplicitStateDatabase();
    const database = new (requireNodeSqlite().DatabaseSync)(databasePath);
    try {
      database.exec(`
        CREATE TABLE cron_run_logs (
          store_key TEXT NOT NULL, job_id TEXT NOT NULL,
          seq INTEGER NOT NULL, ts INTEGER NOT NULL,
          entry_json TEXT NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY (store_key, job_id, seq)
        );
        INSERT INTO cron_run_logs VALUES
          ('store', 'retained-job', 1, 1000,
           '{"ts":1000,"jobId":"retained-job","action":"finished","status":"ok"}', 1000);
      `);
    } finally {
      database.close();
    }
    const before = snapshotSourceFamily(databasePath);

    await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toMatchObject({
      foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      status: "indeterminate",
      reason: expect.stringMatching(/legacy-cron-run-logs.*doctor --fix/),
    });
    expect(snapshotSourceFamily(databasePath)).toEqual(before);
  });

  it("accepts a copied current schema with a future bare nullable column without touching it", async () => {
    const sourcePath = createExplicitStateDatabase();
    const databasePath = path.join(
      tempDirs.make("openclaw-copied-state-preflight-"),
      "candidate.sqlite",
    );
    fs.copyFileSync(sourcePath, databasePath);
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("ALTER TABLE worktrees ADD COLUMN future_note TEXT;");
    } finally {
      database.close();
    }
    const before = snapshotSourceFamily(databasePath);

    await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toEqual({
      schema: "openclaw.state-schema-preflight.v1",
      databasePath,
      targetVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      ownership: null,
      status: "exact",
      requiresWrite: false,
      issues: [],
    });
    expect(snapshotSourceFamily(databasePath)).toEqual(before);
  });

  it("classifies a drifted canonical named index as startup-repairable", async () => {
    const databasePath = createExplicitStateDatabase();
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        DROP INDEX idx_task_runs_status;
        CREATE INDEX idx_task_runs_status ON task_runs(task_id);
      `);
    } finally {
      database.close();
    }

    await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toEqual({
      schema: "openclaw.state-schema-preflight.v1",
      databasePath,
      targetVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      ownership: null,
      status: "startup-repairable",
      requiresWrite: true,
      issues: [
        {
          code: "missing-or-drifted-index",
          message: "missing or drifted index idx_task_runs_status",
          objectName: "idx_task_runs_status",
        },
      ],
    });
  });

  it.each([false, true])(
    "admits legacy additive columns without writes, rejecting genuine drift=%s",
    async (drift) => {
      const initialPath = createExplicitStateDatabase();
      const stateDir = path.dirname(initialPath);
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      fs.mkdirSync(path.dirname(databasePath));
      fs.renameSync(initialPath, databasePath);
      const database = new (requireNodeSqlite().DatabaseSync)(databasePath);
      database.exec(
        "ALTER TABLE task_runs DROP COLUMN tool_use_count; ALTER TABLE task_runs DROP COLUMN last_tool_name; ALTER TABLE apns_registrations DROP COLUMN relay_origin;",
      );
      if (drift) {
        database.exec("ALTER TABLE task_runs ADD COLUMN unrecognized INTEGER NOT NULL DEFAULT 0");
      }
      database.close();
      const before = snapshotSourceFamily(databasePath);
      expect(await preflightOpenClawStateDatabasePath(databasePath)).toMatchObject({
        foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
        status: drift ? "incompatible" : "startup-repairable",
      });
      const admission = assertOpenClawDatabasesReady({
        env: { OPENCLAW_STATE_DIR: stateDir },
        operation: "gateway-startup",
        config: {},
      });
      if (drift) {
        await expect(admission).rejects.toThrow("requires repair");
      } else {
        await expect(admission).resolves.toBeUndefined();
      }
      expect(snapshotSourceFamily(databasePath)).toEqual(before);
    },
  );

  it("classifies the same-version run-end cleanup column as startup-repairable without touching the source", async () => {
    const sourcePath = createExplicitStateDatabase(
      OPENCLAW_STATE_SCHEMA_SQL.replace(
        "  removed_at INTEGER,\n  run_end_cleanup_json TEXT\n",
        "  removed_at INTEGER\n",
      ),
    );
    const snapshotPath = path.join(
      tempDirs.make("openclaw-consolidated-state-preflight-"),
      "candidate.sqlite",
    );
    const sqlite = requireNodeSqlite();
    const writer = new sqlite.DatabaseSync(sourcePath);
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      writer
        .prepare(
          "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES ('preflight.probe', '{}', 1)",
        )
        .run();
      await sqlite.backup(writer, snapshotPath);
      writer
        .prepare(
          "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES ('preflight.after-backup', '{}', 2)",
        )
        .run();
      expect(fs.existsSync(`${sourcePath}-wal`)).toBe(true);
      expect(fs.existsSync(`${sourcePath}-shm`)).toBe(true);
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        expect(fs.existsSync(`${snapshotPath}${suffix}`)).toBe(false);
      }
      const before = snapshotSourceFamily(sourcePath);

      const result = await preflightOpenClawStateDatabasePath(snapshotPath);

      expect(result).toMatchObject({
        foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
        status: "startup-repairable",
        requiresWrite: true,
        issues: [
          {
            code: "missing-column",
            objectName: "worktrees.run_end_cleanup_json",
          },
        ],
      });
      expect(snapshotSourceFamily(sourcePath)).toEqual(before);
    } finally {
      writer.close();
    }
  });

  it("classifies a copied database without the host boot id as startup-repairable", async () => {
    const sourcePath = createExplicitStateDatabase(
      OPENCLAW_STATE_SCHEMA_SQL.replace(
        "  startup_reason TEXT,\n  reason TEXT,\n  host_boot_id TEXT\n",
        "  startup_reason TEXT,\n  reason TEXT\n",
      ),
    );
    const databasePath = path.join(
      tempDirs.make("openclaw-copied-host-boot-preflight-"),
      "candidate.sqlite",
    );
    fs.copyFileSync(sourcePath, databasePath);
    const before = snapshotSourceFamily(sourcePath);

    await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toMatchObject({
      foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      status: "startup-repairable",
      requiresWrite: true,
      issues: [
        {
          code: "missing-column",
          objectName: "gateway_boot_lifecycle.host_boot_id",
        },
      ],
    });
    expect(snapshotSourceFamily(sourcePath)).toEqual(before);
  });

  it("accepts first-use session group columns without requiring a startup write", async () => {
    const databasePath = createExplicitStateDatabase(
      OPENCLAW_STATE_SCHEMA_SQL.replace(
        "  created_at INTEGER NOT NULL,\n  cwd TEXT,\n  worktree INTEGER\n",
        "  created_at INTEGER NOT NULL\n",
      ),
    );

    await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toMatchObject({
      status: "exact",
      requiresWrite: false,
      issues: [],
    });
  });

  it("rejects an explicit preflight path with sidecars without touching it", async () => {
    const databasePath = createExplicitStateDatabase();
    const sqlite = requireNodeSqlite();
    const writer = new sqlite.DatabaseSync(databasePath);
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      writer
        .prepare(
          "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES ('preflight.live', '{}', 1)",
        )
        .run();
      const before = snapshotSourceFamily(databasePath);

      await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toMatchObject({
        foundVersion: null,
        status: "indeterminate",
        requiresWrite: false,
        reason: expect.stringMatching(/consolidated snapshot.*sidecars.*online backup/iu),
      });
      expect(snapshotSourceFamily(databasePath)).toEqual(before);
    } finally {
      writer.close();
    }
  });

  it("reports an explicit unreadable path as indeterminate", async () => {
    const stateDir = tempDirs.make("openclaw-explicit-unreadable-preflight-");
    const databasePath = path.join(stateDir, "not-sqlite.db");
    fs.writeFileSync(databasePath, "not a sqlite database");

    await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toMatchObject({
      databasePath,
      foundVersion: null,
      status: "indeterminate",
      requiresWrite: false,
      reason: expect.stringMatching(/database|file/iu),
    });
  });

  it("reports invalid negative schema metadata as indeterminate", async () => {
    const databasePath = createExplicitStateDatabase();
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA user_version = -1;");
    } finally {
      database.close();
    }

    await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toMatchObject({
      foundVersion: -1,
      status: "indeterminate",
      reason: expect.stringContaining("invalid schema version metadata"),
    });
  });
});
