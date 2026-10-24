// Install fixture mocks before importing the real maintenance owners.
import "./doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as originalCapture from "../commands/doctor-original-capture.js";
import { preflightUpdateDoctorCli } from "../commands/doctor-update-schema-guard.js";
import { createTranscriptEventInserter } from "../config/sessions/transcript-payload.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import * as sqliteSnapshot from "../infra/sqlite-snapshot-source.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { createUpdateRun, recordUpdateRunStep } from "../infra/update-run-ledger.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import { finalizeActiveDebugProxyCaptures } from "../proxy-capture/runtime-cleanup.js";
import { initializeDebugProxyCaptureAsync } from "../proxy-capture/runtime.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import { migrateOpenClawAgentDatabaseForMaintenance } from "../state/openclaw-agent-db-maintenance.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_V24_SQL } from "../state/openclaw-agent-schema-v24.test-support.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../state/openclaw-state-db-contract.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "../state/openclaw-state-db.js";
import { addPreCutoverClientCredentialTablesForTest } from "../state/openclaw-state-schema.test-support.js";
import { VERSION } from "../version.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const { mocks, createDoctorRuntime, withDoctorState, stubDoctorEnv } =
  await import("./doctor-health.test-support.js");
const repairOptions = { repair: true, nonInteractive: true };
const readFiles = (files: string[]) => files.map((file) => fs.readFileSync(file));
const backupPaths = (file: string, prefix: string) =>
  fs
    .readdirSync(path.dirname(file))
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(path.dirname(file), name));

async function closeDatabases() {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}

function executeSql(file: string, sql: string) {
  using db = new DatabaseSync(file);
  db.exec(sql);
}

function setSchemaVersion(databasePath: string, version: number): void {
  using db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA user_version = ${version};`);
  db.prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'").run(version);
}

function readDatabase(databasePath: string) {
  using db = new DatabaseSync(databasePath, { readOnly: true });
  const rows = (table: string, query: string) =>
    tableExists(db, table) ? db.prepare(query).all() : [];
  return {
    version: db.prepare("PRAGMA user_version").get()?.user_version,
    contentVersion: rows(
      "config_machine_state",
      "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
    )[0]?.value_json,
    ledger: rows("update_runs", "SELECT * FROM update_runs ORDER BY run_id"),
    captureSessions: rows("capture_sessions", "SELECT id, mode FROM capture_sessions ORDER BY id"),
  };
}

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  mocks.config.mockReturnValue({});
  mocks.packageRoot.mockReturnValue(undefined);
  mocks.runContributions.mockReset();
  mocks.outro.mockClear();
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
});

it.each([
  "orphan",
  "other foreign key",
  "orphan and other foreign key",
  "orphan with other foreign key",
] as const)("backs up orphan-window repairs before a schema upgrade (%s)", async (damage) => {
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "0");
  await withDoctorState(async (state) => {
    const shared = openOpenClawStateDatabase({ env: state.env }).path;
    const agent = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
    await closeDatabases();
    setSchemaVersion(shared, 19);
    executeSql(shared, "ALTER TABLE cron_run_receipts DROP COLUMN delivery_attempt_state");
    const readRows = (db: DatabaseSync) => ({
      nodes: db.prepare("SELECT * FROM session_nodes ORDER BY session_key").all(),
      windows: db.prepare("SELECT * FROM session_windows ORDER BY session_id").all(),
      events: db.prepare("SELECT * FROM transcript_events ORDER BY session_id, seq").all(),
    });
    let original: ReturnType<typeof readRows>;
    {
      using db = openNodeSqliteDatabase(agent);
      admitSqliteSchema(db);
      db.exec(`PRAGMA foreign_keys = OFF;
            INSERT INTO session_nodes(session_key, current_session_id, entry_json, updated_at)
            VALUES ('agent:main:retained', 'retained', '{"sessionId":"retained","updatedAt":1}', 1);
            INSERT INTO session_windows(session_id, session_key, created_at, updated_at)
            VALUES ('retained', 'agent:main:retained', 1, 1);`);
      createTranscriptEventInserter(
        db,
        "retained",
      )({
        seq: 0,
        eventJson: '{"type":"message","message":{"role":"user","content":"keep"}}',
        createdAt: 1,
      });
      if (damage.includes("orphan")) {
        db.exec(`INSERT INTO session_windows(session_id, session_key, created_at, updated_at)
              VALUES ('orphan', 'agent:main:missing', 1, 1)`);
      }
      if (damage.includes("other")) {
        db.prepare(
          "UPDATE session_windows SET primary_conversation_id = 'missing' WHERE session_id = ?",
        ).run(damage === "orphan with other foreign key" ? "orphan" : "retained");
      }
      original = readRows(db);
    }
    const runtime = createDoctorRuntime();
    const doctor = runDoctorHealthFlow(runtime, repairOptions);
    if (damage === "orphan") {
      await doctor;
      expect(readDatabase(shared).version).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
      // Scoped archives retain source versions in metadata; inspect the full image here.
      const migrationBackups = backupPaths(shared, "openclaw.sqlite.pre-startup-migration-").filter(
        (name) => name.endsWith(".bak") && !name.endsWith(".scoped.bak"),
      );
      expect(migrationBackups).toHaveLength(1);
      expect(readDatabase(migrationBackups[0]!).version).toBe(19);
      expect(mocks.runContributions).toHaveBeenCalledOnce();
      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("Removed 1 orphan session window(s)"),
      );
    } else {
      await expect(doctor).rejects.toThrow(
        /foreign_key_check.*Stop the Gateway.*doctor --fix.*restart/s,
      );
      expect(readDatabase(shared).version).toBe(19);
      expect(mocks.runContributions).not.toHaveBeenCalled();
    }
    using db = new DatabaseSync(agent, { readOnly: true });
    expect(readRows(db)).toEqual(
      damage === "orphan"
        ? {
            ...original,
            windows: original.windows.filter((row) => row.session_id !== "orphan"),
          }
        : original,
    );
    const backups = backupPaths(agent, "openclaw-session-window-recovery-");
    expect(backups).toHaveLength(damage.includes("orphan") ? 1 : 0);
    if (backups[0]) {
      using saved = new DatabaseSync(path.join(backups[0], "database.sqlite"), {
        readOnly: true,
      });
      expect(readRows(saved)).toEqual(original);
    }
  });
});

it.each([
  { kind: "state", updaterVersion: "2026.9.2", json: false },
  { kind: "state", updaterVersion: "2026.9.2", json: true },
  { kind: "agent", updaterVersion: "2026.9.2", json: false },
  { kind: "agent", updaterVersion: "2026.9.2-rebuild.1", json: false },
])(
  "refuses an unfenced $kind upgrade ($updaterVersion, json=$json)",
  async ({ kind, updaterVersion, json }) => {
    await withDoctorState(async (state) => {
      const shared = openOpenClawStateDatabase({ env: state.env }).path;
      const agent = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
      createUpdateRun({ trigger: "cli", before: { version: updaterVersion } });
      await closeDatabases();
      const target = kind === "state" ? shared : agent;
      const supported =
        kind === "state" ? OPENCLAW_STATE_SCHEMA_VERSION : OPENCLAW_AGENT_SCHEMA_VERSION;
      setSchemaVersion(target, supported - 1);
      if (kind === "state") {
        executeSql(shared, "DROP TABLE config_machine_state");
      }
      const before = readDatabase(shared);
      const quarantine = state.statePath("state", "openclaw-quarantine.sqlite");
      fs.writeFileSync(quarantine, "unreadable quarantine fixture");
      const files = [shared, agent, state.configPath, quarantine];
      const bytes = readFiles(files);
      const runtime = { ...createDoctorRuntime(), writeStdout: vi.fn(), writeJson: vi.fn() };

      const failure = await runDoctorHealthFlow(runtime, { ...repairOptions, json }).catch(
        (error: unknown) => error,
      );
      const refusal = {
        code: "update-schema-bump-unfenced",
        updaterVersion,
        databases: [
          { kind, path: target, foundVersion: supported - 1, supportedVersion: supported },
        ],
        commands: [
          "openclaw gateway stop",
          `npm install -g openclaw@${VERSION} --allow-scripts=openclaw`,
          "openclaw doctor --fix",
          "openclaw gateway start",
        ],
      };
      if (json) {
        expect(failure).toMatchObject({ code: 1 });
        expect(runtime.exit).toHaveBeenCalledWith(1);
        expect(runtime.writeJson).toHaveBeenCalledWith(
          {
            ok: false,
            error: expect.objectContaining({ ...refusal, targetVersion: VERSION }),
          },
          2,
        );
      } else {
        expect(failure).toMatchObject(refusal);
      }
      expect(readFiles(files)).toEqual(bytes);
      expect(readDatabase(shared)).toEqual(before);
      expect(mocks.runContributions).not.toHaveBeenCalled();
    });
  },
);

it.each([
  { driver: "2026.9.2", deferred: true },
  { driver: "2026.9.3-beta.1", deferred: false },
])("defers debug capture until schema publication ($driver)", async ({ driver, deferred }) => {
  await withDoctorState(async (state) => {
    const captureSessionId = `doctor-readiness-${driver}`;
    stubDoctorEnv({
      OPENCLAW_DEBUG_PROXY_ENABLED: "1",
      OPENCLAW_DEBUG_PROXY_SESSION_ID: captureSessionId,
      OPENCLAW_DEBUG_PROXY_URL: undefined,
      OPENCLAW_DEBUG_PROXY_REQUIRE: "1",
    });
    const shared = openOpenClawStateDatabase({ env: state.env }).path;
    const run = createUpdateRun({ trigger: "cli", before: { version: driver } });
    await closeOpenClawStateDatabaseAsync();
    // The restored credential tables belong to the schema before their local-owner cutover.
    const sourceVersion = CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION - 1;
    {
      using predecessor = new DatabaseSync(shared);
      addPreCutoverClientCredentialTablesForTest(predecessor);
    }
    setSchemaVersion(shared, sourceVersion);
    mocks.runContributions.mockImplementation(async () => {
      const result = repairOpenClawStateDatabaseSchema({ env: state.env });
      expect(result.warnings).toEqual([]);
      await initializeDebugProxyCaptureAsync("before-readiness");
    });
    const runtime = createDoctorRuntime();
    try {
      await runDoctorHealthFlow(runtime, repairOptions);
    } finally {
      await finalizeActiveDebugProxyCaptures();
      await closeOpenClawStateDatabaseAsync();
    }
    expect(readDatabase(shared)).toMatchObject({
      version: deferred ? sourceVersion : OPENCLAW_STATE_SCHEMA_VERSION,
      captureSessions: deferred ? [] : [{ id: captureSessionId, mode: "cli" }],
    });
    if (deferred) {
      expect(readDatabase(shared).contentVersion).toBe(String(OPENCLAW_STATE_SCHEMA_VERSION));
      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining(
          `Schema content applied; version publication deferred until update run ${run.runId} finishes`,
        ),
      );
    }
    expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
  });
});

it.each([
  "owned",
  "flag-only",
  "foreign-agent",
  "early foreign-agent",
  "changed namespace",
] as const)("fences outer rehearsal on current maintenance (%s)", async (mode) => {
  await withDoctorState(async (state) => {
    const shared = openOpenClawStateDatabase({ env: state.env }).path;
    let agent = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
    const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
    recordUpdateRunStep(run.runId, {
      step: "openclaw doctor",
      status: mode === "early foreign-agent" ? "in_progress" : "completed",
    });
    if (mode !== "early foreign-agent") {
      recordUpdateRunStep(run.runId, {
        step: "post-update verification",
        status: "in_progress",
      });
    }
    await closeDatabases();
    // Frozen v24 storage preserves the exact input to the candidate schema migration.
    fs.unlinkSync(agent);
    {
      using seed = new DatabaseSync(agent);
      seed.exec(OPENCLAW_AGENT_SCHEMA_V24_SQL);
      seed.exec(`PRAGMA user_version = 24;
            INSERT INTO schema_meta(meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
            VALUES ('primary', 'agent', 24, 'main', '2026.9.9', 1, 1)`);
      seed.exec(
        "INSERT INTO cache_entries(scope,key,value_json,expires_at,updated_at) VALUES('test','retained','{\"keep\":true}',NULL,1)",
      );
    }
    if (mode === "foreign-agent" || mode === "early foreign-agent") {
      const foreign = state.path("foreign-agent");
      fs.mkdirSync(foreign);
      const moved = path.join(foreign, "openclaw-agent.sqlite");
      fs.renameSync(agent, moved);
      agent = moved;
      await state.writeConfig({
        plugins: { enabled: false },
        agents: { ownership: "explicit", entries: { main: { agentDir: foreign } } },
      });
      if (mode === "early foreign-agent") {
        registerOpenClawAgentDatabase({
          agentId: "main",
          path: agent,
          env: state.env,
          schemaVersion: 24,
        });
      }
      await closeOpenClawStateDatabaseAsync();
    }
    const root = fs.realpathSync(state.stateDir);
    stubDoctorEnv({
      ...buildUpdateDoctorEnv({
        allowGatewayServiceRepair: false,
        allowGatewayActivation: false,
        serviceRepairPolicy: "external",
      }),
      ...buildUpdateRehearsalPathEnv(root),
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_UPDATE_RUN_ID: undefined,
      OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
    });
    if (mode === "flag-only") {
      vi.stubEnv("TMPDIR", path.dirname(root));
    }
    const before = readFiles([agent, state.configPath]);
    const snapshot = sqliteSnapshot.prepareSqliteReadOnlyLocation;
    const observe = vi
      .spyOn(sqliteSnapshot, "prepareSqliteReadOnlyLocation")
      .mockImplementation(async (...args) => {
        const prepared = await snapshot(...args);
        if (mode === "changed namespace" && getOpenClawDatabaseMaintenanceScope()) {
          vi.stubEnv("TMPDIR", path.dirname(root));
        }
        return prepared;
      });
    const runtime = createDoctorRuntime();
    // Observe the actual capture owner without replacing its implementation.
    const capture = vi.spyOn(originalCapture, "preserveDoctorOriginalState");
    mocks.runContributions.mockImplementation(async () => {
      const scope = getOpenClawDatabaseMaintenanceScope();
      expect(scope?.ownsSchemaMaintenance).toBe(true);
      if (!scope) {
        throw new Error("Expected real Doctor maintenance");
      }
      scope.assertOwnerCurrent();
      scope.assertDatabaseAccess(shared);
      await withAgentDatabaseMaintenanceLease({ env: process.env }, (lease) =>
        migrateOpenClawAgentDatabaseForMaintenance({ agentId: "main", pathname: agent }, lease),
      );
    });
    try {
      if (mode === "flag-only") {
        await expect(preflightUpdateDoctorCli({})).rejects.toMatchObject({
          code: "update-schema-bump-unfenced",
        });
      } else {
        // The actual CLI preflight must not cache state-only facts as a full fleet.
        const preflight = await preflightUpdateDoctorCli({});
        expect(preflight).toBeUndefined();
        const doctor = runDoctorHealthFlow(runtime, repairOptions, undefined, preflight);
        if (mode === "owned") {
          await doctor;
          expect(
            mocks.runContributions,
            runtime.log.mock.calls.flat().join("\n"),
          ).toHaveBeenCalledOnce();
        } else {
          await expect(doctor).rejects.toThrow(
            mode === "changed namespace" ? /namespace changed/ : /schema|coverage|rehearsal/i,
          );
        }
      }
      if (mode !== "owned") {
        expect(capture).not.toHaveBeenCalled();
        expect(mocks.runContributions).not.toHaveBeenCalled();
      }
      expect(fs.readFileSync(state.configPath)).toEqual(before[1]);
      if (mode === "owned") {
        using migrated = new DatabaseSync(agent, { readOnly: true });
        expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_AGENT_SCHEMA_VERSION,
        );
        expect(
          migrated.prepare("SELECT value_json FROM cache_entries WHERE key='retained'").get(),
        ).toEqual({ value_json: '{"keep":true}' });
      } else {
        expect(fs.readFileSync(agent)).toEqual(before[0]);
      }
    } finally {
      observe.mockRestore();
      capture.mockRestore();
      await closeOpenClawStateDatabaseAsync();
    }
  });
});
