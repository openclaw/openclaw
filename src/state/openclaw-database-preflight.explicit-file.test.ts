import { deepStrictEqual } from "node:assert/strict";
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
  function execDatabase(databasePath: string, sql: string) {
    const database = new (requireNodeSqlite().DatabaseSync)(databasePath);
    try {
      database.exec(sql);
    } finally {
      database.close();
    }
  }

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

  it.each([
    {
      name: "runtime schema",
      create: () => {
        const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-runtime-state-preflight-") };
        const opened = openOpenClawStateDatabase({ env });
        expect(
          opened.db
            .prepare(
              "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'execution_identity_contexts'",
            )
            .get(),
        ).toBeUndefined();
        closeOpenClawStateDatabaseForTest();
        return opened.path;
      },
      expected: {},
    },
    {
      name: "retired cron history",
      create: () => {
        const databasePath = createExplicitStateDatabase();
        execDatabase(
          databasePath,
          `
          CREATE TABLE cron_run_logs (
            store_key TEXT NOT NULL, job_id TEXT NOT NULL,
            seq INTEGER NOT NULL, ts INTEGER NOT NULL,
            entry_json TEXT NOT NULL, created_at INTEGER NOT NULL,
            PRIMARY KEY (store_key, job_id, seq)
          );
          INSERT INTO cron_run_logs VALUES
            ('store', 'retained-job', 1, 1000,
             '{"ts":1000,"jobId":"retained-job","action":"finished","status":"ok"}', 1000);
        `,
        );
        return databasePath;
      },
      expected: {
        status: "indeterminate",
        reason: expect.stringMatching(/legacy-cron-run-logs.*doctor --fix/),
      },
    },
    {
      name: "copied schema with a future nullable column",
      create: () => {
        const source = createExplicitStateDatabase();
        const databasePath = path.join(
          tempDirs.make("openclaw-copied-state-preflight-"),
          "candidate.sqlite",
        );
        fs.copyFileSync(source, databasePath);
        execDatabase(databasePath, "ALTER TABLE worktrees ADD COLUMN future_note TEXT;");
        return databasePath;
      },
      expected: {},
    },
    {
      name: "drifted canonical index",
      create: () => {
        const databasePath = createExplicitStateDatabase();
        execDatabase(
          databasePath,
          "DROP INDEX idx_task_runs_status; CREATE INDEX idx_task_runs_status ON task_runs(task_id);",
        );
        return databasePath;
      },
      expected: {
        status: "startup-repairable",
        requiresWrite: true,
        issues: [
          {
            code: "missing-or-drifted-index",
            message: "missing or drifted index idx_task_runs_status",
            objectName: "idx_task_runs_status",
          },
        ],
      },
    },
    {
      name: "first-use session group columns",
      create: () =>
        createExplicitStateDatabase(
          OPENCLAW_STATE_SCHEMA_SQL.replace(
            "  created_at INTEGER NOT NULL,\n  cwd TEXT,\n  worktree INTEGER\n",
            "  created_at INTEGER NOT NULL\n",
          ),
        ),
      expected: {},
    },
    {
      name: "unreadable file",
      create: () => {
        const databasePath = path.join(
          tempDirs.make("openclaw-explicit-unreadable-preflight-"),
          "not-sqlite.db",
        );
        fs.writeFileSync(databasePath, "not a sqlite database");
        return databasePath;
      },
      expected: {
        foundVersion: null,
        status: "indeterminate",
        reason: expect.stringMatching(/database|file/iu),
      },
    },
    {
      name: "negative schema metadata",
      create: () => {
        const databasePath = createExplicitStateDatabase();
        execDatabase(databasePath, "PRAGMA user_version = -1;");
        return databasePath;
      },
      expected: {
        foundVersion: -1,
        status: "indeterminate",
        reason: expect.stringContaining("invalid schema version metadata"),
      },
    },
  ])("classifies $name without changing the source", async ({ create, expected }) => {
    const databasePath = create();
    const before = snapshotSourceFamily(databasePath);
    await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toEqual({
      schema: "openclaw.state-schema-preflight.v1",
      databasePath,
      targetVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      ownership: null,
      issues: [],
      status: "exact",
      requiresWrite: false,
      ...expected,
    });
    deepStrictEqual(snapshotSourceFamily(databasePath), before);
  });

  it.each([false, true])(
    "admits legacy additive columns without writes, rejecting genuine drift=%s",
    async (drift) => {
      const initialPath = createExplicitStateDatabase();
      const stateDir = path.dirname(initialPath);
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      fs.mkdirSync(path.dirname(databasePath));
      fs.renameSync(initialPath, databasePath);
      execDatabase(
        databasePath,
        "ALTER TABLE task_runs DROP COLUMN tool_use_count; ALTER TABLE task_runs DROP COLUMN last_tool_name; ALTER TABLE apns_registrations DROP COLUMN relay_origin;" +
          (drift
            ? "ALTER TABLE task_runs ADD COLUMN unrecognized INTEGER NOT NULL DEFAULT 0;"
            : ""),
      );
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
      deepStrictEqual(snapshotSourceFamily(databasePath), before);
    },
  );

  it.each(["run_end_cleanup_json", "gc_protection_json"])(
    "classifies the same-version %s column as startup-repairable without touching the source",
    async (column) => {
      const sourcePath = createExplicitStateDatabase(OPENCLAW_STATE_SCHEMA_SQL);
      const snapshotPath = path.join(
        tempDirs.make("openclaw-consolidated-state-preflight-"),
        "candidate.sqlite",
      );
      const sqlite = requireNodeSqlite();
      const writer = new sqlite.DatabaseSync(sourcePath);
      try {
        writer.exec(`ALTER TABLE worktrees DROP COLUMN ${column};`);
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
              objectName: `worktrees.${column}`,
            },
          ],
        });
        deepStrictEqual(snapshotSourceFamily(sourcePath), before);
      } finally {
        writer.close();
      }
    },
  );

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
      deepStrictEqual(snapshotSourceFamily(databasePath), before);
    } finally {
      writer.close();
    }
  });
});
