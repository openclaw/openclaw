// Windows database path tests exercise canonical state lifecycles beyond MAX_PATH.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { noteDoctorAgentDatabasePathHealth } from "../commands/doctor-agent-database-paths.js";
import { compactDoctorSessionSqliteTarget } from "../commands/doctor-session-sqlite-compact.js";
import { runDoctorStateSqliteCompact } from "../commands/doctor-state-sqlite-compact.js";
import {
  readUpdateStateSchemaVersions,
  updateStateSchemaVersionsMatch,
} from "../infra/update-candidate-state.js";
import { createUpdateRun, finishUpdateRun } from "../infra/update-run-ledger.js";
import { withOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { preflightOpenClawDatabaseSchemas } from "./openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { withOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  openExistingOpenClawStateDatabaseReadOnly,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const MAX_PATH = 260;
const AGENT_ID = "windows-long-path";
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function createDeepStateEnv(): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: tempDirs.make("openclaw-database-paths-windows-"),
  };
  while (
    resolveOpenClawStateSqlitePath(env).length <= MAX_PATH ||
    resolveOpenClawAgentSqlitePath({ agentId: AGENT_ID, env }).length <= MAX_PATH
  ) {
    env.OPENCLAW_STATE_DIR = path.join(env.OPENCLAW_STATE_DIR, `segment-${"x".repeat(24)}`);
  }
  fs.mkdirSync(env.OPENCLAW_STATE_DIR, { recursive: true });
  return env;
}

describe("OpenClaw database paths on Windows", () => {
  it.runIf(process.platform === "win32")(
    "migrates legacy namespace collisions through startup and Doctor",
    () => {
      for (const repair of [false, true]) {
        const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-native-legacy-alias-") };
        const database = openOpenClawStateDatabase({ env });
        const agentPath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
        const insert = database.db.prepare(
          "INSERT INTO agent_databases VALUES ('main', ?, ?, ?, ?)",
        );
        insert.run(agentPath, 18, 100, 10);
        insert.run(path.toNamespacedPath(agentPath), 20, 200, 20);
        database.db.exec(
          "PRAGMA user_version=8; UPDATE schema_meta SET schema_version=8 WHERE meta_key='primary'",
        );
        closeOpenClawStateDatabaseForTest();
        if (repair) {
          expect(repairOpenClawStateDatabaseSchema({ env }).warnings).toEqual([]);
        }
        const migrated = openOpenClawStateDatabase({ env });
        expect(migrated.db.prepare("SELECT * FROM agent_databases").all()).toEqual([
          {
            agent_id: "main",
            path: path.join("agents", "main", "agent", "openclaw-agent.sqlite"),
            schema_version: 20,
            last_seen_at: 200,
            size_bytes: 20,
          },
        ]);
        closeOpenClawStateDatabaseForTest();
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "repairs aliases before a native update baseline and preserves active update inventories",
    async () => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-native-doctor-alias-") };
      const agent = openOpenClawAgentDatabase({ agentId: "main", env });
      const state = openOpenClawStateDatabase({ env });
      const addAlias = () =>
        state.db
          .prepare("INSERT INTO agent_databases VALUES ('main', ?, ?, ?, ?)")
          .run(path.toNamespacedPath(agent.path), OPENCLAW_AGENT_SCHEMA_VERSION, Date.now(), 123);
      const inspect = () =>
        readUpdateStateSchemaVersions({ stateDir: env.OPENCLAW_STATE_DIR, config: {}, env });
      addAlias();
      expect(noteDoctorAgentDatabasePathHealth({ env, shouldRepair: true })).toEqual([]);
      expect(state.db.prepare("SELECT COUNT(*) AS count FROM agent_databases").get()).toEqual({
        count: 1,
      });
      const baseline = await inspect();
      expect(
        updateStateSchemaVersionsMatch(baseline, await inspect(), { sharedPath: state.path }),
      ).toBe(true);

      addAlias();
      const mixedBaseline = await inspect();
      const run = createUpdateRun({ trigger: "cli" }, { env });
      expect(noteDoctorAgentDatabasePathHealth({ env, shouldRepair: true })).toEqual([
        expect.stringContaining(`update ${run.runId} is in progress`),
      ]);
      expect(
        updateStateSchemaVersionsMatch(mixedBaseline, await inspect(), { sharedPath: state.path }),
      ).toBe(true);
      finishUpdateRun(run.runId, { status: "succeeded" }, { env });
      expect(
        noteDoctorAgentDatabasePathHealth({
          env: { ...env, OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1" },
          shouldRepair: true,
        }),
      ).toEqual([expect.stringContaining("during update Doctor")]);
      expect(
        updateStateSchemaVersionsMatch(mixedBaseline, await inspect(), { sharedPath: state.path }),
      ).toBe(true);
    },
  );

  it.runIf(process.platform === "win32")(
    "registers a reopened native filename as the same relative inventory row",
    () => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-native-registration-") };
      const options = { agentId: "main", env };
      const first = openOpenClawAgentDatabase(options);
      const nativeFilename = first.db.location();
      expect(nativeFilename).toBe(path.toNamespacedPath(first.path));
      if (nativeFilename === null) {
        throw new Error("Expected a file-backed database");
      }
      closeOpenClawAgentDatabasesForTest();
      openOpenClawAgentDatabase({ ...options, path: nativeFilename });
      const state = openOpenClawStateDatabase({ env });
      expect(state.db.prepare("SELECT agent_id, path FROM agent_databases").all()).toEqual([
        { agent_id: "main", path: path.join("agents", "main", "agent", "openclaw-agent.sqlite") },
      ]);

      const external = path.join(tempDirs.make("openclaw-native-external-"), "agent.sqlite");
      const externalNative = path.toNamespacedPath(external);
      openOpenClawAgentDatabase({ agentId: "external", env, path: externalNative });
      expect(
        state.db.prepare("SELECT path FROM agent_databases WHERE agent_id = 'external'").get(),
      ).toEqual({ path: externalNative });
    },
  );

  it.runIf(process.platform === "win32")(
    "opens, preflights, compacts, and reopens canonical databases beyond MAX_PATH",
    async () => {
      const env = createDeepStateEnv();
      const statePath = resolveOpenClawStateSqlitePath(env);
      const agentPath = resolveOpenClawAgentSqlitePath({ agentId: AGENT_ID, env });
      expect(statePath.startsWith("\\\\?\\")).toBe(false);
      expect(agentPath.startsWith("\\\\?\\")).toBe(false);
      expect(statePath.length).toBeGreaterThan(MAX_PATH);
      expect(agentPath.length).toBeGreaterThan(MAX_PATH);

      const state = openOpenClawStateDatabase({ env });
      const agent = openOpenClawAgentDatabase({ agentId: AGENT_ID, env });
      expect(state.path).toBe(statePath);
      expect(agent.path).toBe(agentPath);
      expect(
        state.db
          .prepare("SELECT role, schema_version FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({ role: "global", schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
      expect(
        agent.db
          .prepare(
            "SELECT role, schema_version, agent_id FROM schema_meta WHERE meta_key = 'primary'",
          )
          .get(),
      ).toEqual({
        role: "agent",
        schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
        agent_id: AGENT_ID,
      });
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();

      expect(
        withOpenClawStateDatabaseReadOnly(
          ({ db, path: pathname }) => ({
            pathname,
            version: db.prepare("PRAGMA user_version;").get(),
          }),
          { env },
        ),
      ).toEqual({
        pathname: statePath,
        version: { user_version: OPENCLAW_STATE_SCHEMA_VERSION },
      });
      expect(
        withOpenClawAgentDatabaseReadOnly(
          ({ db, path: pathname }) => ({
            pathname,
            version: db.prepare("PRAGMA user_version;").get(),
          }),
          { agentId: AGENT_ID, env },
        ),
      ).toEqual({
        found: true,
        value: {
          pathname: agentPath,
          version: { user_version: OPENCLAW_AGENT_SCHEMA_VERSION },
        },
      });
      expect(
        await preflightOpenClawDatabaseSchemas({
          env,
          supportedVersions: {
            state: OPENCLAW_STATE_SCHEMA_VERSION,
            agent: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
        }),
      ).toEqual({ incompatible: [], indeterminate: [] });
      fs.rmSync(`${statePath}-wal`, { force: true });
      fs.rmSync(`${statePath}-shm`, { force: true });
      const stateBytesBeforeReadOnly = fs.readFileSync(statePath);
      const stateEntriesBeforeReadOnly = fs
        .readdirSync(path.dirname(statePath), { withFileTypes: true })
        .map((entry) => entry.name)
        .toSorted();
      const readOnlyState = await openExistingOpenClawStateDatabaseReadOnly({ env });
      expect(readOnlyState?.path).toBe(statePath);
      expect(
        readOnlyState?.db
          .prepare("SELECT role, schema_version FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({ role: "global", schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
      const openedStatePath = readOnlyState?.db.prepare("PRAGMA database_list").get() as
        | { file?: unknown }
        | undefined;
      expect(path.resolve(String(openedStatePath?.file))).not.toBe(path.resolve(statePath));
      const privateDirectory = path.dirname(String(openedStatePath?.file));
      expect(readOnlyState?.walMaintenance.close()).toBe(true);
      expect(fs.existsSync(privateDirectory)).toBe(false);
      assert.deepStrictEqual(fs.readFileSync(statePath), stateBytesBeforeReadOnly);
      expect(
        fs
          .readdirSync(path.dirname(statePath), { withFileTypes: true })
          .map((entry) => entry.name)
          .toSorted(),
      ).toEqual(stateEntriesBeforeReadOnly);

      await expect(runDoctorStateSqliteCompact({ env })).resolves.toMatchObject({
        integrityCheck: "ok",
        path: statePath,
        skipped: false,
      });
      expect(
        await compactDoctorSessionSqliteTarget(
          {
            agentId: AGENT_ID,
            storePath: path.join(
              env.OPENCLAW_STATE_DIR ?? "",
              "agents",
              AGENT_ID,
              "sessions",
              "sessions.json",
            ),
          },
          { env },
        ),
      ).toMatchObject({
        freelistAfterPages: 0,
        skipped: false,
        walSizeAfterBytes: 0,
      });

      expect(openOpenClawStateDatabase({ env }).path).toBe(statePath);
      expect(openOpenClawAgentDatabase({ agentId: AGENT_ID, env }).path).toBe(agentPath);
    },
  );
});
