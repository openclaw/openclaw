import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { removeCanonicalValidationFromHistoricalAgentFixture } from "../state/openclaw-agent-db.test-support.js";
import { LEGACY_PARTICIPANTS_SCHEMA } from "../state/openclaw-agent-schema-history.js";
import { restoreEmptyV21StorageForHistoricalFixture } from "../state/openclaw-agent-schema-v21.test-support.js";
import {
  cleanupSessionStateForTest,
  useSessionStoreTempDirs,
} from "../test-utils/session-state-cleanup.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import { sessionSqlFixture } from "./doctor-session-sqlite.sql.test-support.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-doctor-canonical-store-");

function doctor(store: Awaited<ReturnType<typeof createStore>>, mode: "recover" | "inspect") {
  return runDoctorSessionSqlite({ cfg: store.cfg, env: store.env, allAgents: true, mode });
}

function migrate(store: Awaited<ReturnType<typeof createStore>>) {
  return migrateLegacyMediaPersistence({
    configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(store.cfg, {
      env: store.env,
    }),
    env: store.env,
  });
}

async function createStore() {
  const root = sessionDirs.make();
  const stateDir = path.join(root, "state");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const storePath = path.join(root, "custom", "shared.sqlite");
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { qa: {} } },
    session: { store: storePath },
  };
  const scope = {
    agentId: "qa",
    defaultAgentId: "main",
    env,
    sessionKey: "agent:qa:doctor",
    storePath,
  };
  await upsertSessionEntryCore(scope, { sessionId: "doctor-session", updatedAt: 1 });
  const options = toDatabaseOptions(resolveSqliteReadScope(scope));
  const sqlitePath = resolveOpenClawAgentSqlitePath(options);
  await cleanupSessionStateForTest({ stateDir, rootPath: root });
  return { cfg, env, options, root, scope, sqlitePath, stateDir, storePath };
}

async function createHistoricalSharedStore() {
  const store = await createStore();
  using database = openNodeSqliteDatabase(store.sqlitePath);
  const sql = sessionSqlFixture(database);
  restoreEmptyV21StorageForHistoricalFixture(database);
  removeCanonicalValidationFromHistoricalAgentFixture(database);
  database.exec("DROP TABLE session_participants;");
  database.exec(LEGACY_PARTICIPANTS_SCHEMA);
  sql`INSERT INTO session_participants VALUES (${store.scope.sessionKey}, 'human', 'person', 'profile', 3, 10, 20)`.run();
  database.exec("PRAGMA user_version = 17; UPDATE schema_meta SET schema_version = 17;");
  database.exec(`
      INSERT INTO cache_entries (scope, key, value_json, expires_at, updated_at)
        VALUES ('doctor', 'preserved', '{"ok":true}', 100, 1);
      DROP INDEX idx_agent_cache_expiry;
      CREATE INDEX idx_agent_cache_expiry ON cache_entries(key);
    `);
  database.enableDefensive?.(false);
  database.exec(`PRAGMA writable_schema = ON;
      UPDATE sqlite_schema SET sql = 'CREATE INDEX idx_agent_cache_expiry ON cache_entries(scope, expires_at, key) WHERE expires_at IS NOT NULL'
        WHERE name = 'idx_agent_cache_expiry';
      PRAGMA writable_schema = OFF;`);
  const schemaCookie = Number(database.prepare("PRAGMA schema_version").get()?.schema_version);
  database.exec(`PRAGMA schema_version = ${schemaCookie + 1};`);
  return store;
}

async function repairHistoricalSharedStore(store: Awaited<ReturnType<typeof createStore>>) {
  const report = await doctor(store, "recover");
  expect(report.totals.issues).toBe(0);
  expect(report.targets[0]?.corruptRecovery).toBeUndefined();
}

function expectUpgradedSharedStore(store: Awaited<ReturnType<typeof createHistoricalSharedStore>>) {
  const reopened = openOpenClawAgentDatabase(store.options);
  const sql = sessionSqlFixture(reopened.db);
  expect(reopened.agentId).toBe("main");
  expect(sql`PRAGMA user_version`.get()?.user_version).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  expect(sql`SELECT agent_id, schema_version FROM schema_meta`.get()).toEqual({
    agent_id: "main",
    schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
  });
  expect(loadExactSessionEntry(store.scope)?.entry.sessionId).toBe("doctor-session");
  expect(sql`PRAGMA foreign_key_check`.all()).toEqual([]);
  expect(sql`PRAGMA integrity_check`.get()?.integrity_check).toBe("ok");
}

function sharedData(sqlitePath: string) {
  using database = openNodeSqliteDatabase(sqlitePath, { readOnly: true });
  return {
    version: database.prepare("PRAGMA user_version").get(),
    rows: ["schema_meta", "session_nodes", "session_participants", "retained_participant_view"].map(
      (table) => database.prepare(`SELECT * FROM ${table}`).all(),
    ),
  };
}

describe("Doctor canonical session SQLite targets", () => {
  it("fences live writers before recovering the physical shared owner", async () => {
    const store = await createHistoricalSharedStore();
    const before = fs.readFileSync(store.sqlitePath);
    // A real lease not attached to a cached handle survives maintenance's
    // local handle cleanup, just like another process's active writer.
    const lease = claimOpenClawAgentDatabaseLease({
      agentId: "main",
      path: store.sqlitePath,
      env: store.env,
    });
    try {
      const migrated = await migrate(store);
      expect(migrated.changes).toEqual([]);
      expect(migrated.warnings).toEqual([
        expect.stringMatching(
          /^Agent database maintenance deferred: .*stop the Gateway and other OpenClaw processes, or reboot, then rerun openclaw doctor --fix/s,
        ),
      ]);
      await expect(repairHistoricalSharedStore(store)).rejects.toThrow(
        /stop the Gateway and other OpenClaw processes, or reboot, then rerun openclaw doctor --fix/,
      );
      expect(fs.readFileSync(store.sqlitePath)).toEqual(before);
    } finally {
      releaseOpenClawAgentDatabaseLease(lease, { env: store.env });
    }
    await repairHistoricalSharedStore(store);
    expectUpgradedSharedStore(store);
    const sql = sessionSqlFixture(openOpenClawAgentDatabase(store.options).db);
    expect(sql`SELECT value_json FROM cache_entries WHERE scope = 'doctor'`.get()).toEqual({
      value_json: '{"ok":true}',
    });
  });

  it("keeps shared data in place when participant dependencies refuse canonical-index recovery", async () => {
    const store = await createHistoricalSharedStore();
    {
      using database = openNodeSqliteDatabase(store.sqlitePath);
      database.exec(
        "CREATE VIEW retained_participant_view AS SELECT actor_id FROM session_participants;",
      );
    }
    const before = sharedData(store.sqlitePath);
    const report = await doctor(store, "recover");
    expect(report.targets[0]?.issues).toEqual([
      expect.objectContaining({
        code: "sqlite_recovery_inspect_failed",
        message: expect.stringContaining(
          "Participant migration cannot rebuild unknown indexes, views, or triggers",
        ),
      }),
    ]);
    expect(report.targets[0]?.corruptRecovery).toBeUndefined();
    expect(
      fs.readdirSync(path.dirname(store.sqlitePath)).some((file) => file.includes(".corrupt-")),
    ).toBe(false);
    const migrated = await migrate(store);
    expect(migrated).toEqual({
      changes: [],
      warnings: [
        `Skipped agent database migration for ${store.sqlitePath}: Error: Participant migration cannot rebuild unknown indexes, views, or triggers.`,
      ],
    });
    expect(sharedData(store.sqlitePath)).toEqual(before);
  });

  it("never treats an exact SQLite database as a legacy import file", async () => {
    const store = await createStore();
    const original = fs.readFileSync(store.sqlitePath);
    const report = await runDoctorSessionSqlite({
      cfg: store.cfg,
      env: store.env,
      allAgents: true,
      mode: "import",
    });

    expect(report.targets).toEqual([]);
    expect(report.migrationRun).toBeUndefined();
    expect(fs.readFileSync(store.sqlitePath)).toEqual(original);
    expect(fs.existsSync(path.join(store.stateDir, "session-sqlite-migration-runs"))).toBe(false);
    expect(loadExactSessionEntry(store.scope)?.entry.sessionId).toBe("doctor-session");
  });

  it("inspects the shared SQLite database without a legacy session file", async () => {
    const store = await createStore();
    const report = await doctor(store, "inspect");

    expect(report.totals).toMatchObject({
      targets: 1,
      legacyEntries: 0,
      sqliteEntries: 1,
      issues: 0,
    });
    expect(report.targets[0]).toMatchObject({
      sqlitePath: store.sqlitePath,
      dbStats: { integrityCheck: "ok" },
    });
    expect(loadExactSessionEntry(store.scope)?.entry.sessionId).toBe("doctor-session");
    expect(openOpenClawAgentDatabase(store.options).agentId).toBe("main");
  });
});
