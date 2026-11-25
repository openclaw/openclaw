import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeFixtureJsonSync } from "../cli/cli-fixtures.test-support.js";
import { createConfigIO } from "../config/io.factory.js";
import { getDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createPathResolutionEnv } from "../test-utils/env.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { readConfigSnapshotForEngineSelection } from "./config-preflight-snapshot.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

function writePostgresAnchor(filename: string) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  using anchor = new DatabaseSync(filename);
  anchor.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)");
  anchor.exec("INSERT INTO openclaw_engine_anchor VALUES ('workboard', 'postgres', 'port_legacy')");
}

it.each(["direct", "root include", "database include"])(
  "persists published 2026.11.1 intent through Workboard config commits (%s)",
  async (format) => {
    const home = dirs.make("openclaw-workboard-upgrade-");
    const env = createPathResolutionEnv(home, { OPENCLAW_CONFIG_PATH: undefined });
    resetDatabaseEngineSelectionForTest();
    const statePath = openOpenClawStateDatabase({ env }).path;
    await closeOpenClawStateDatabaseByPathAsync(statePath);
    const anchorPath = path.join(home, ".openclaw/plugins/workboard/workboard.sqlite");
    writePostgresAnchor(anchorPath);
    const configPath = path.join(home, ".openclaw/openclaw.json");
    const legacy = {
      database: {
        engine: "postgres",
        postgres: { connection: "postgresql://localhost/synthetic" },
      },
      gateway: { mode: "local" },
      agents: { entries: { main: {} } },
    };
    const includePath = path.join(home, ".openclaw/legacy-database.json");
    if (format !== "direct") {
      writeFixtureJsonSync(includePath, format === "root include" ? legacy : legacy.database);
    }
    writeFixtureJsonSync(
      configPath,
      format === "direct"
        ? legacy
        : format === "root include"
          ? { $include: "legacy-database.json" }
          : { ...legacy, database: { $include: "legacy-database.json" } },
    );
    const configBefore = fs.readFileSync(configPath);
    const includeBefore = format === "direct" ? undefined : fs.readFileSync(includePath);
    const stateBefore = fs.readFileSync(statePath);
    const anchorBefore = fs.readFileSync(anchorPath);
    const io = createConfigIO({ env, pluginValidation: "core-only" });
    try {
      const selected = await readConfigSnapshotForEngineSelection(env);
      expect(selected.valid).toBe(true);
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);
      expect(getDatabaseEngineSelection()?.effectiveEngines).toMatchObject({
        state: "sqlite",
        agent: "sqlite",
        workboard: "postgres",
        logbook: "sqlite",
        "team-reports": "sqlite",
      });
      expect(snapshot.config.database).toMatchObject({
        engine: "sqlite",
        families: { workboard: { engine: "postgres" } },
      });
      expect(fs.readFileSync(statePath)).toEqual(stateBefore);
      expect(fs.readFileSync(anchorPath)).toEqual(anchorBefore);
      // The scoped port starts from authored bytes and unsets the override when
      // SQLite equals the normalized default. Publication invalidates recognition.
      await io.writeConfigFile(structuredClone(snapshot.authoredConfig ?? snapshot.sourceConfig), {
        baseSnapshot: snapshot,
        inputBase: "source",
        databaseAccess: "none",
        unsetPaths: [["database", "families", "workboard", "engine"]],
        observe: false,
        skipPluginValidation: true,
        skipRuntimeSnapshotRefresh: true,
        skipOutputLogs: true,
        beforeCommit: async () => {
          fs.rmSync(anchorPath);
          using workboard = new DatabaseSync(anchorPath);
          workboard.exec(
            "CREATE TABLE workboard_cards (id TEXT); INSERT INTO workboard_cards VALUES ('retained')",
          );
        },
      });
      expect(JSON.parse(fs.readFileSync(configPath, "utf8")).database?.engine).toBe("sqlite");
      expect(fs.readFileSync(`${configPath}.bak`)).toEqual(configBefore);
      resetDatabaseEngineSelectionForTest();
      await readConfigSnapshotForEngineSelection(env);
      expect((await io.readConfigFileSnapshot()).valid).toBe(true);
      expect(getDatabaseEngineSelection()?.effectiveEngines).toMatchObject({
        state: "sqlite",
        agent: "sqlite",
        workboard: "sqlite",
      });
      if (includeBefore) {
        expect(fs.readFileSync(includePath)).toEqual(includeBefore);
        const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
        expect(format === "root include" ? persisted.$include : persisted.database.$include).toBe(
          "legacy-database.json",
        );
        return;
      }
      const sqlite = await io.readConfigFileSnapshot({ observe: false });
      const candidate = structuredClone(sqlite.authoredConfig ?? sqlite.sourceConfig);
      candidate.database = {
        ...candidate.database,
        families: { workboard: { engine: "postgres" } },
      };
      await io.writeConfigFile(candidate, {
        baseSnapshot: sqlite,
        inputBase: "source",
        databaseAccess: "none",
        explicitSetPaths: [["database", "families", "workboard", "engine"]],
        observe: false,
        skipPluginValidation: true,
        skipRuntimeSnapshotRefresh: true,
        skipOutputLogs: true,
        beforeCommit: async () => {
          fs.rmSync(anchorPath);
          writePostgresAnchor(anchorPath);
        },
      });
      resetDatabaseEngineSelectionForTest();
      await readConfigSnapshotForEngineSelection(env);
      expect((await io.readConfigFileSnapshot()).valid).toBe(true);
      expect(getDatabaseEngineSelection()?.effectiveEngines).toMatchObject({
        state: "sqlite",
        agent: "sqlite",
        workboard: "postgres",
      });
    } finally {
      await closeOpenClawStateDatabaseByPathAsync(statePath);
      resetDatabaseEngineSelectionForTest();
    }
  },
);

it.each([
  { state: "postgres", families: undefined },
  { state: "empty", families: undefined },
  { state: "sqlite", families: { state: { engine: "postgres" as const } } },
])(
  "preserves global PostgreSQL intent with $state state and explicit families $families",
  async ({ state, families }) => {
    const home = dirs.make("openclaw-global-postgres-");
    const env = createPathResolutionEnv(home, { OPENCLAW_CONFIG_PATH: undefined });
    const statePath = path.join(home, ".openclaw/state/openclaw.sqlite");
    writePostgresAnchor(statePath);
    if (state === "empty") {
      using db = new DatabaseSync(statePath);
      db.exec("DROP TABLE openclaw_engine_anchor; VACUUM");
    }
    if (state === "sqlite") {
      using db = new DatabaseSync(statePath);
      db.exec("DROP TABLE openclaw_engine_anchor; CREATE TABLE fixture_state (value TEXT)");
      db.exec("INSERT INTO fixture_state VALUES ('retained')");
    }
    writePostgresAnchor(path.join(home, ".openclaw/plugins/workboard/workboard.sqlite"));
    writeFixtureJsonSync(path.join(home, ".openclaw/openclaw.json"), {
      database: {
        engine: "postgres",
        families,
        postgres: { connection: "postgresql://localhost/synthetic" },
      },
    });
    try {
      resetDatabaseEngineSelectionForTest();
      const snapshot = await readConfigSnapshotForEngineSelection(env);
      expect(snapshot.valid).toBe(true);
      expect(snapshot.config.database?.engine).toBe("postgres");
      expect(getDatabaseEngineSelection()?.effectiveEngines).toMatchObject({
        state: "postgres",
        agent: "postgres",
      });
    } finally {
      resetDatabaseEngineSelectionForTest();
    }
  },
);

it.each([
  { mode: "default", isolated: false, options: undefined },
  { mode: "isolated", isolated: true, options: { isolateEnv: true } },
  { mode: "shared", isolated: false, options: { isolateEnv: false } },
])(
  "selects the final PostgreSQL target using the supplied environment ($mode)",
  async ({ isolated, options }) => {
    const home = dirs.make("openclaw-engine-target-");
    const bootstrap = path.join(home, ".openclaw");
    const target = path.join(home, "target");
    fs.mkdirSync(bootstrap);
    fs.mkdirSync(target);
    writeFixtureJsonSync(path.join(bootstrap, "openclaw.json"), {
      env: {
        vars: {
          OPENCLAW_STATE_DIR: target,
          ENGINE_TARGET_TEST_DSN: "postgresql://synthetic@127.0.0.1:1/engine_target",
        },
      },
    });
    writeFixtureJsonSync(path.join(target, "openclaw.json"), {
      database: {
        engine: "postgres",
        postgres: {
          connection: { source: "env", provider: "default", id: "ENGINE_TARGET_TEST_DSN" },
        },
      },
    });
    const env = createPathResolutionEnv(home, {
      OPENCLAW_CONFIG_PATH: undefined,
      ENGINE_TARGET_TEST_DSN: undefined,
    });
    const before = { ...env };
    const processEnv = { ...process.env };
    const sql = observeMainThreadSql();
    try {
      resetDatabaseEngineSelectionForTest();
      const snapshot = await readConfigSnapshotForEngineSelection(env, options);
      expect(snapshot).toMatchObject({
        valid: true,
        path: path.join(target, "openclaw.json"),
        config: { database: { engine: "postgres" } },
      });
      expect(getDatabaseEngineSelection()).toMatchObject({
        effectiveEngines: { state: "postgres", agent: "postgres" },
        postgres: { connection: "postgresql://synthetic@127.0.0.1:1/engine_target" },
      });
      expect(
        Object.keys({ ...before, ...env })
          .filter((key) => before[key] !== env[key])
          .toSorted(),
      ).toEqual(isolated ? [] : ["ENGINE_TARGET_TEST_DSN", "OPENCLAW_STATE_DIR"]);
      expect(
        Object.keys({ ...processEnv, ...process.env }).filter(
          (key) => processEnv[key] !== process.env[key],
        ),
      ).toEqual([]);
      expect(fs.readdirSync(bootstrap)).toEqual(["openclaw.json"]);
      expect(fs.readdirSync(target)).toEqual(["openclaw.json"]);
      sql.expectIdle();
    } finally {
      sql.restore();
      resetDatabaseEngineSelectionForTest();
    }
  },
);
