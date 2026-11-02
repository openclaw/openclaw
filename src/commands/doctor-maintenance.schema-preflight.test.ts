import "../flows/doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCommandWithRuntime } from "../cli/cli-utils.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runDoctorHealthFlow } from "../flows/doctor-health.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { corruptSqliteIndexKey } from "../infra/sqlite-index-corruption.test-support.js";
import { cleanupSnapshotOperations } from "../infra/sqlite-readonly-location-cleanup.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { createLegacyDatabaseFixture } from "../infra/state-migrations.media-persistence.test-support.js";
import { setLoggerOverride } from "../logging/logger.js";
import { testApi } from "../logging/logger.test-support.js";
import { readAgentDeletionRecoveryHolds } from "../state/agent-deletion-journal-recovery.kernel.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { seedOpenClawDatabaseQuarantine } from "../state/openclaw-quarantine-store.test-support.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import { STATE_SUPERVISION_KEY } from "../state/openclaw-state-ownership.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const withState = (run: (state: OpenClawTestState) => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal" }, run);
const { mocks } = await import("../flows/doctor-health.test-support.js");
beforeEach(() => {
  mocks.config.mockReturnValue({});
  mocks.packageRoot.mockReturnValue(undefined);
  mocks.outro.mockClear();
  mocks.runContributions.mockReset();
});

afterEach(() => vi.unstubAllEnvs());

const auditRows = "SELECT * FROM audit_events NOT INDEXED";
const integrity = "PRAGMA integrity_check";
const runtimeMock = () => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() });
const runRepair = (runtime: ReturnType<typeof runtimeMock>) =>
  runCommandWithRuntime(runtime, () =>
    runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true }),
  );
const outputOf = (runtime: ReturnType<typeof runtimeMock>) =>
  [...runtime.log.mock.calls, ...runtime.error.mock.calls].flat().join("\n");

function readRows(pathname: string, sql: string, ...params: string[]) {
  const { DatabaseSync } = requireNodeSqlite();
  using db = new DatabaseSync(pathname, { readOnly: true });
  return db.prepare(sql).all(...params);
}

function writeDatabase(pathname: string, sql: string) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  using database = new DatabaseSync(pathname);
  database.exec(sql);
}

it("fails repair for an old configured agentDir schema", async () => {
  await withState(async (state) => {
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
    const runtime = runtimeMock();
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

it("refuses newer agent schemas before repairing the registry", async () => {
  await withState(async (state) => {
    const agentPath = state.path("custom", "sessions.sqlite");
    const databasePath = state.statePath("state", "openclaw.sqlite");
    await state.writeConfig({
      agents: { ownership: "explicit", entries: { main: {} } },
      session: { store: agentPath },
    });
    writeDatabase(
      databasePath,
      `
      PRAGMA user_version = 8;
      CREATE TABLE agent_databases (
        agent_id TEXT NOT NULL, path TEXT NOT NULL, schema_version INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL, size_bytes INTEGER, PRIMARY KEY (agent_id, path)
      );
      ${extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "agent_deletion_journal")}
      ${extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "migration_sources")}
    `,
    );
    writeDatabase(
      agentPath,
      `
      PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};
      CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, agent_id TEXT);
      INSERT INTO schema_meta VALUES ('primary', 'main');
    `,
    );
    const paths = [state.configPath, databasePath, agentPath];
    const before = paths.map((pathname) => fs.readFileSync(pathname));

    await expect(
      runDoctorHealthFlow(runtimeMock(), { repair: true, nonInteractive: true }),
    ).rejects.toThrow("newer than this build");
    expect(paths.map((pathname) => fs.readFileSync(pathname))).toEqual(before);
  });
});

it("preserves audit rows and missing deletion history through index repair", async () => {
  await withState(async (state) => {
    const heldPath = createLegacyDatabaseFixture({
      agentId: "retained",
      env: state.env,
      eventsBySession: {},
      schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
      path: state.path("external-agent", "openclaw-agent.sqlite"),
    });
    const heldBytes = fs.readFileSync(heldPath);
    const resultPath = state.path("doctor-result.json");
    vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", resultPath);
    const initial = openOpenClawStateDatabase({ env: state.env });
    initial.db.exec("DROP TABLE agent_deletion_journal");
    initial.db.exec(`INSERT INTO audit_events
      (event_id, source_id, source_sequence, occurred_at, kind, action, status, actor_type, actor_id)
      VALUES ('index-original', 'fixture-source', 1, 1, 'message', 'received', 'ok', 'system', 'fixture')`);
    const rows = initial.db.prepare(auditRows).all();
    closeOpenClawStateDatabaseForTest();
    const index = "sqlite_autoindex_audit_events_1";
    corruptSqliteIndexKey(initial.path, index, "index-original", "index-damaged!");
    expect(readRows(initial.path, auditRows)).toEqual(rows);
    const findings = readRows(initial.path, integrity);
    expect(findings).toContainEqual({ integrity_check: `row 1 missing from index ${index}` });
    const quarantine = () =>
      seedOpenClawDatabaseQuarantine({
        env: state.env,
        kind: "state",
        path: initial.path,
        reason: `row 1 missing from index ${index}`,
      });
    quarantine();
    const runtime = runtimeMock();
    const cleanupLog = state.path("snapshot-cleanup.log");
    let snapshotPath: string | undefined;
    let removalFailures = 0;
    const copyFile = fs.copyFileSync;
    const remove = fs.rmSync;
    const copy = vi.spyOn(fs, "copyFileSync").mockImplementation((source, destination, mode) => {
      copyFile(source, destination, mode);
      const directory = path.dirname(String(destination));
      if (
        path.dirname(directory) === path.dirname(initial.path) &&
        path.basename(directory).startsWith("openclaw-index-recovery-")
      ) {
        snapshotPath = String(source);
      }
    });
    const cleanup = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (String(target) === snapshotPath) {
        removalFailures += 1;
        throw Object.assign(new Error("private snapshot busy"), { code: "EBUSY" });
      }
      remove(target, options);
    });
    try {
      setLoggerOverride({ level: "warn", file: cleanupLog });
      await runRepair(runtime);
      expect(removalFailures).toBeGreaterThan(0);
      expect(snapshotPath && fs.existsSync(snapshotPath)).toBe(true);
      await testApi.flushFileLogQueueForTests();
      expect(fs.readFileSync(cleanupLog, "utf8")).toContain(
        "SQLite read-only snapshot cleanup failed",
      );
    } finally {
      copy.mockRestore();
      cleanup.mockRestore();
      await cleanupSnapshotOperations()
        .then(() => testApi.flushFileLogQueueForTests())
        .finally(() => setLoggerOverride(null));
    }
    expect(snapshotPath && fs.existsSync(snapshotPath)).toBe(false);

    const output = outputOf(runtime);
    expect(runtime.exit, output).not.toHaveBeenCalled();
    expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
    expect(mocks.writeUpdatePostInstallDoctorResult).toHaveBeenCalledWith({
      resultPath,
      result: expect.objectContaining({
        status: "ok",
        warnings: expect.arrayContaining([expect.stringContaining(heldPath)]),
      }),
    });
    expect(output).toContain(`Warning: Rebuilt corrupt shared-state SQLite indexes: ${index}`);
    const backupPrefix = "Saved pre-repair SQLite backup: ";
    const backupLine = runtime.log.mock.calls
      .flat()
      .find((line) => String(line).startsWith(backupPrefix));
    expect(backupLine).toBeTypeOf("string");
    const backupPath = String(backupLine).slice(backupPrefix.length);
    expect(readRows(backupPath, integrity)).toEqual(findings);
    expect(readRows(backupPath, auditRows)).toEqual(rows);
    const repaired = openOpenClawStateDatabase({ env: state.env });
    expect(repaired.db.prepare(integrity).all()).toEqual([{ integrity_check: "ok" }]);
    const expectRetained = () => {
      const current = openOpenClawStateDatabase({ env: state.env });
      expect(current.db.prepare(auditRows).all()).toEqual(rows);
      expect(readAgentDeletionRecoveryHolds(current)).toEqual([
        { agentId: "retained", path: heldPath },
      ]);
      expect(fs.readFileSync(heldPath)).toEqual(heldBytes);
    };
    expectRetained();
    expect(output).toContain("recorded a Doctor receipt");

    // Model a committed REINDEX whose quarantine finalization was interrupted.
    closeOpenClawStateDatabaseForTest();
    quarantine();
    runtime.exit.mockClear();
    runtime.error.mockClear();
    await runRepair(runtime);
    expect(runtime.exit, runtime.error.mock.calls.flat().join("\n")).not.toHaveBeenCalled();
    expectRetained();
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
      const readOwner = (scan: string) =>
        readRows(
          databasePath,
          `SELECT value_json FROM config_machine_state ${scan} WHERE state_key = ?`,
          STATE_SUPERVISION_KEY,
        );
      expect(readOwner("")).toEqual([]);
      expect(readOwner("NOT INDEXED")).toEqual([{ value_json: JSON.stringify(ownership) }]);
      const findings = readRows(databasePath, integrity);
      expect(findings).toContainEqual({
        integrity_check: expect.stringContaining(`missing from index ${index}`),
      });
      const runtime = runtimeMock();
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
      expect(readRows(databasePath, integrity)).toEqual(findings);
    },
  );
});
