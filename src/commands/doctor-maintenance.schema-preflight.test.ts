import "../flows/doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandWithRuntime } from "../cli/cli-utils.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runDoctorHealthFlow } from "../flows/doctor-health.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { corruptSqliteIndexKey } from "../infra/sqlite-index-corruption.test-support.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { createLegacyDatabaseFixture } from "../infra/state-migrations.media-persistence.test-support.js";
import { readAgentDeletionRecoveryHolds } from "../state/agent-deletion-journal-recovery.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { recordOpenClawDatabaseQuarantine } from "../state/openclaw-quarantine-store.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import { STATE_SUPERVISION_KEY } from "../state/openclaw-state-ownership.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const { mocks } = await import("../flows/doctor-health.test-support.js");
beforeEach(() => {
  mocks.config.mockReturnValue({});
  mocks.packageRoot.mockReturnValue(undefined);
  mocks.outro.mockClear();
  mocks.runContributions.mockReset();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

function createLegacyRegistryFixture() {
  const root = tempDirs.make("openclaw-doctor-legacy-registry-");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  for (const [key, value] of Object.entries({
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
  })) {
    vi.stubEnv(key, value);
  }
  vi.stubEnv("OPENCLAW_HOME", undefined);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA user_version = 8;
    CREATE TABLE agent_databases (
      agent_id TEXT NOT NULL, path TEXT NOT NULL, schema_version INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL, size_bytes INTEGER,
      PRIMARY KEY (agent_id, path)
    );
  `);
  database.close();
  const config: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { main: {} } },
  };
  return { root, configPath, databasePath, config };
}

function readRows(databasePath: string, sql: string) {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}

function createRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function runRepair(runtime: ReturnType<typeof createRuntime>) {
  return runCommandWithRuntime(runtime, () =>
    runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true }),
  );
}

it("fails repair when a configured agentDir database remains on an older schema", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentDir = state.statePath(".openclaw", "agents", "worker", "agent");
    const config: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { worker: { agentDir } } },
    };
    await state.writeConfig(config);
    mocks.config.mockReturnValue(config);
    const databasePath = createLegacyDatabaseFixture({
      agentId: "worker",
      env: state.env,
      eventsBySession: {},
      path: path.join(agentDir, "openclaw-agent.sqlite"),
      schemaVersion: 19,
    });
    unregisterOpenClawAgentDatabase({ agentId: "worker", env: state.env, path: databasePath });
    mocks.runContributions.mockImplementation(async (ctx) => {
      ctx.runtime.log("Migration refused; configured database left unchanged.");
    });
    const runtime = createRuntime();
    await runRepair(runtime);

    expect(mocks.runContributions).toHaveBeenCalledOnce();
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
    const errors = runtime.error.mock.calls.flat().join("\n");
    expect(errors).toContain(databasePath);
    expect(errors).toContain("uses schema version 19");
    expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
    expect(readRows(databasePath, "PRAGMA user_version")).toEqual([{ user_version: 19 }]);
  });
});

it.each(["configured", "registered"] as const)(
  "refuses a newer %s SQLite database before repairing an old registry",
  async (discovery) => {
    const fixture = createLegacyRegistryFixture();
    const customDir = path.join(fixture.root, "custom");
    const agentPath = path.join(customDir, "sessions.sqlite");
    fixture.config.session = { store: agentPath };
    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const registry = new DatabaseSync(fixture.databasePath);
    registry.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "agent_deletion_journal"));
    registry.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "migration_sources"));
    if (discovery === "registered") {
      fixture.config.agents!.entries!.ops = {};
      registry
        .prepare("INSERT INTO agent_databases VALUES (?, ?, ?, ?, ?)")
        .run("ops", agentPath, OPENCLAW_AGENT_SCHEMA_VERSION, 1, null);
    }
    registry.close();
    const agent = new DatabaseSync(agentPath);
    agent.exec(`
      PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};
      CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, agent_id TEXT);
      INSERT INTO schema_meta VALUES ('primary', 'main');
    `);
    agent.close();
    fs.writeFileSync(fixture.configPath, JSON.stringify(fixture.config));
    const paths = [fixture.configPath, fixture.databasePath, agentPath];
    const before = paths.map((pathname) => fs.readFileSync(pathname));

    await expect(
      runDoctorHealthFlow(createRuntime(), { repair: true, nonInteractive: true }),
    ).rejects.toThrow(discovery === "registered" ? "for agent ops" : "newer than this build");
    expect(paths.map((pathname) => fs.readFileSync(pathname))).toEqual(before);
  },
);

it("lets the schema repair owner restore a noncanonical shared-state index", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const initial = openOpenClawStateDatabase({ env: state.env });
    initial.db.exec(`DROP INDEX idx_task_runs_status;
        CREATE INDEX idx_task_runs_status ON task_runs(task_id)`);
    closeOpenClawStateDatabaseForTest();
    mocks.runContributions.mockImplementation(async (ctx) => {
      const result = repairOpenClawStateDatabaseSchema({ env: state.env });
      ctx.runtime.log([...result.changes, ...result.warnings].join("\n"));
    });
    const runtime = createRuntime();
    await runRepair(runtime);

    const output = [...runtime.log.mock.calls, ...runtime.error.mock.calls].flat().join("\n");
    expect(mocks.runContributions, output).toHaveBeenCalledOnce();
    expect(runtime.exit, output).not.toHaveBeenCalled();
    expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
    expect(
      readRows(initial.path, "SELECT name FROM pragma_index_info('idx_task_runs_status')"),
    ).toEqual([{ name: "status" }]);
  });
});

it("repairs a quarantined audit index while preserving stores with missing deletion history", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const heldPath = createLegacyDatabaseFixture({
      agentId: "retained",
      env: state.env,
      eventsBySession: {},
      schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
      path: state.path("external-agent", "openclaw-agent.sqlite"),
    });
    const heldBytes = fs.readFileSync(heldPath);
    const initial = openOpenClawStateDatabase({ env: state.env });
    initial.db.exec("DROP TABLE agent_deletion_journal");
    initial.db.exec(`INSERT INTO audit_events
      (event_id, source_id, source_sequence, occurred_at, kind, action, status, actor_type, actor_id)
      VALUES ('index-original', 'fixture-source', 1, 1, 'message', 'received', 'ok', 'system', 'fixture')`);
    const rows = initial.db.prepare("SELECT * FROM audit_events NOT INDEXED").all();
    closeOpenClawStateDatabaseForTest();
    const index = "sqlite_autoindex_audit_events_1";
    corruptSqliteIndexKey(initial.path, index, "index-original", "index-damaged!");
    const findings = readRows(initial.path, "PRAGMA integrity_check");
    expect(findings).toContainEqual({ integrity_check: `row 1 missing from index ${index}` });
    expect(readRows(initial.path, "SELECT * FROM audit_events NOT INDEXED")).toEqual(rows);
    const quarantine = () =>
      expect(
        recordOpenClawDatabaseQuarantine({
          env: state.env,
          kind: "state",
          path: initial.path,
          reason: `row 1 missing from index ${index}`,
        }),
      ).toBe(true);
    quarantine();
    const runtime = createRuntime();
    await runRepair(runtime);

    const output = [...runtime.log.mock.calls, ...runtime.error.mock.calls].flat().join("\n");
    expect(runtime.exit, output).toHaveBeenCalledExactlyOnceWith(1);
    expect(output).toContain("Failing check agent-deletion-journal");
    expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
    expect(output).toContain(`Warning: Rebuilt corrupt shared-state SQLite indexes: ${index}`);
    const backupLine = runtime.log.mock.calls
      .flat()
      .find((line) => String(line).startsWith("Saved pre-repair SQLite backup: "));
    expect(backupLine).toBeTypeOf("string");
    const backupPath = String(backupLine).slice("Saved pre-repair SQLite backup: ".length);
    expect(readRows(backupPath, "PRAGMA integrity_check")).toEqual(findings);
    expect(readRows(backupPath, "SELECT * FROM audit_events NOT INDEXED")).toEqual(rows);
    const repaired = openOpenClawStateDatabase({ env: state.env });
    expect(repaired.db.prepare("PRAGMA integrity_check").all()).toEqual([
      { integrity_check: "ok" },
    ]);
    const assertPreserved = () => {
      const current = openOpenClawStateDatabase({ env: state.env });
      expect(current.db.prepare("SELECT * FROM audit_events NOT INDEXED").all()).toEqual(rows);
      expect(readAgentDeletionRecoveryHolds(current)).toEqual([
        { agentId: "retained", path: heldPath },
      ]);
      expect(fs.readFileSync(heldPath)).toEqual(heldBytes);
    };
    assertPreserved();
    expect(output).toContain("recorded a Doctor receipt");

    // Model a committed REINDEX whose quarantine finalization was interrupted.
    closeOpenClawStateDatabaseForTest();
    quarantine();
    runtime.exit.mockClear();
    runtime.error.mockClear();
    await runRepair(runtime);
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(runtime.error.mock.calls.flat().join("\n")).toContain(
      "Failing check agent-deletion-journal",
    );
    assertPreserved();
  });
});

it("Doctor refuses table corruption with preservation and recovery guidance", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const initial = openOpenClawStateDatabase({ env: state.env });
    initial.db.exec(`CREATE TABLE damaged_table (value TEXT NOT NULL CHECK (value = 'valid'));
      PRAGMA ignore_check_constraints = ON;
      INSERT INTO damaged_table VALUES ('damaged');
      PRAGMA ignore_check_constraints = OFF;`);
    closeOpenClawStateDatabaseForTest();
    const before = fs.readFileSync(initial.path);
    const runtime = createRuntime();
    await runRepair(runtime);

    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
    const error = runtime.error.mock.calls.flat().join("\n");
    expect(error).toContain("CHECK constraint failed in damaged_table");
    expect(error).toContain("Preserve the database and its WAL");
    expect(error).toContain("restore a verified backup or use SQLite recovery");
    expect(fs.readFileSync(initial.path)).toEqual(before);
  });
});

it("Doctor refuses to rebuild an index that hides the external state owner", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_SUPERVISOR_MODE: undefined } },
    async (state) => {
      const externalEnv = { ...state.env, OPENCLAW_SUPERVISOR_MODE: "external" };
      const ownership = claimOpenClawStateOwnership("fixture-supervisor", { env: externalEnv });
      const databasePath = openOpenClawStateDatabase({ env: externalEnv }).path;
      closeOpenClawStateDatabaseForTest();
      const index = "sqlite_autoindex_config_machine_state_1";
      corruptSqliteIndexKey(databasePath, index, STATE_SUPERVISION_KEY, "gateway.supervisioX");
      const before = fs.readFileSync(databasePath);
      const { DatabaseSync } = requireNodeSqlite();
      const damaged = new DatabaseSync(databasePath, { readOnly: true });
      let findings;
      try {
        expect(
          damaged
            .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
            .get(STATE_SUPERVISION_KEY),
        ).toBeUndefined();
        expect(
          damaged
            .prepare("SELECT value_json FROM config_machine_state NOT INDEXED WHERE state_key = ?")
            .get(STATE_SUPERVISION_KEY),
        ).toEqual({ value_json: JSON.stringify(ownership) });
        findings = damaged.prepare("PRAGMA integrity_check").all();
        expect(findings).toContainEqual({
          integrity_check: expect.stringContaining(`missing from index ${index}`),
        });
      } finally {
        damaged.close();
      }
      const runtime = createRuntime();
      await runRepair(runtime);

      expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(runtime.error.mock.calls.flat().join("\n")).toContain(
        "externally supervised by fixture-supervisor",
      );
      expect(
        fs.readFileSync(databasePath).equals(before),
        "Doctor must refuse before changing the owner index",
      ).toBe(true);
      expect(
        fs
          .readdirSync(path.dirname(databasePath))
          .filter((name) => name.startsWith("openclaw-index-recovery-")),
      ).toEqual([]);
      expect(readRows(databasePath, "PRAGMA integrity_check")).toEqual(findings);
    },
  );
});
