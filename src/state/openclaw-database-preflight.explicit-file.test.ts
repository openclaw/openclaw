import { deepStrictEqual } from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { closeOpenClawAgentDatabasesForTest } from "./openclaw-agent-db.js";
import {
  assertOpenClawDatabasesReady,
  preflightOpenClawStateDatabasePath,
} from "./openclaw-database-preflight.js";
import {
  snapshotSourceFamily,
  writeUnreadableNewerStateSchema,
} from "./openclaw-database-preflight.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function execDatabase(databasePath: string, sql: string) {
  using database = new (requireNodeSqlite().DatabaseSync)(databasePath);
  database.exec(sql);
}

function createStateDatabase(filename = "candidate.sqlite") {
  const stateDir = tempDirs.make("openclaw-explicit-state-preflight-");
  const databasePath = path.join(stateDir, filename);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  using database = new (requireNodeSqlite().DatabaseSync)(databasePath);
  // Match production bootstrap: one durable commit, not one per schema object.
  runSqliteImmediateTransactionSync(database, () => {
    database.exec(
      `${OPENCLAW_STATE_SCHEMA_SQL};
         PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
         INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
         VALUES ('primary', 'global', ${OPENCLAW_STATE_SCHEMA_VERSION}, NULL, NULL, 1, 1);`,
    );
  });
  return { stateDir, databasePath };
}

it.each([
  [
    "retired cron history",
    `CREATE TABLE cron_run_logs (entry_json TEXT); INSERT INTO cron_run_logs VALUES ('{"retained":true}');`,
    {
      status: "indeterminate",
      reason: expect.stringMatching(/legacy-cron-run-logs.*doctor --fix/),
    },
  ],
  [
    "drifted canonical index",
    "DROP INDEX idx_task_runs_runtime_run; CREATE INDEX idx_task_runs_runtime_run ON task_runs(task_id);",
    {
      status: "startup-repairable",
      requiresWrite: true,
      issues: [
        {
          code: "missing-or-drifted-index",
          message: "missing or drifted index idx_task_runs_runtime_run",
          objectName: "idx_task_runs_runtime_run",
        },
      ],
    },
  ],
  [
    "negative schema metadata",
    "PRAGMA user_version = -1;",
    {
      foundVersion: -1,
      status: "indeterminate",
      reason: expect.stringContaining("invalid schema version metadata"),
    },
  ],
] as const)("classifies %s without changing the source", async (_name, sql, expected) => {
  const { databasePath } = createStateDatabase();
  execDatabase(databasePath, sql);
  const before = snapshotSourceFamily(databasePath);
  await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toEqual({
    schema: "openclaw.state-schema-preflight.v1",
    databasePath,
    targetVersion: OPENCLAW_STATE_SCHEMA_VERSION,
    foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
    ownership: null,
    issues: [],
    requiresWrite: false,
    ...expected,
  });
  deepStrictEqual(snapshotSourceFamily(databasePath), before);
});

it("rejects genuine drift alongside legacy additive columns without writes", async () => {
  const { stateDir, databasePath } = createStateDatabase("state/openclaw.sqlite");
  execDatabase(
    databasePath,
    "ALTER TABLE task_runs DROP COLUMN tool_use_count; ALTER TABLE task_runs DROP COLUMN last_tool_name; ALTER TABLE apns_registrations DROP COLUMN relay_origin; ALTER TABLE task_runs ADD COLUMN unrecognized INTEGER NOT NULL DEFAULT 0;",
  );
  const before = snapshotSourceFamily(databasePath);
  expect(await preflightOpenClawStateDatabasePath(databasePath)).toMatchObject({
    foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
    status: "incompatible",
  });
  const admission = assertOpenClawDatabasesReady({
    env: { OPENCLAW_STATE_DIR: stateDir },
    operation: "gateway-startup",
    config: {},
  });
  await expect(admission).rejects.toThrow("requires repair");
  deepStrictEqual(snapshotSourceFamily(databasePath), before);
});

it.each(["gateway-startup", "gateway-restart", "explicit-file"] as const)(
  "reports only the newer schema for an unreadable catalog through %s",
  async (operation) => {
    const { stateDir, databasePath } = createStateDatabase("state/openclaw.sqlite");
    writeUnreadableNewerStateSchema(databasePath);
    const before = snapshotSourceFamily(databasePath);
    let message: string;
    if (operation === "explicit-file") {
      const result = await preflightOpenClawStateDatabasePath(databasePath);
      expect(result).toMatchObject({
        status: "incompatible",
        foundVersion: OPENCLAW_STATE_SCHEMA_VERSION + 1,
        requiresWrite: false,
        issues: [],
      });
      message = result.reason ?? "";
    } else {
      const failure = await assertOpenClawDatabasesReady({
        env: { OPENCLAW_STATE_DIR: stateDir },
        operation,
        config: {},
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      message = String(failure);
    }
    expect(message).toMatch(/newer/);
    expect(message).toMatch(/build.*supports/);
    expect(message).toMatch(/restore.*backup/);
    expect(message).not.toMatch(/doctor --fix|registry query failed|integrity_check failed/);
    deepStrictEqual(snapshotSourceFamily(databasePath), before);
  },
);

it("rejects an explicit preflight path with sidecars without touching it", async () => {
  const { databasePath } = createStateDatabase();
  using writer = new (requireNodeSqlite().DatabaseSync)(databasePath);
  writer.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
      INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES ('preflight.live', '{}', 1)`);
  const before = snapshotSourceFamily(databasePath);

  await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toMatchObject({
    foundVersion: null,
    status: "indeterminate",
    requiresWrite: false,
    reason: expect.stringMatching(/consolidated snapshot.*sidecars.*online backup/iu),
  });
  deepStrictEqual(snapshotSourceFamily(databasePath), before);
});
