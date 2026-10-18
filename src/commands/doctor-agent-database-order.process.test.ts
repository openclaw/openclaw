import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stripVTControlCharacters } from "node:util";
import { afterAll, beforeAll, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../agents/auth-profiles/credential-fixtures.test-support.js";
import { getCliProcessTestTimeout } from "../cli/cli-process-child.test-helpers.js";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../infra/supervisor-markers.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
} from "../infra/update-doctor-result.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import {
  createBuiltRuntime,
  runBuiltRuntime,
} from "./doctor-config-preflight.process.test-support.js";

const fixtures = createFixtureLifetime();
let runtimeRoot: string;
beforeAll(() => {
  runtimeRoot = createBuiltRuntime(fixtures.createTempDir("doctor-agent-database-runtime-"));
});
afterAll(() => fixtures.cleanup());
const CHILD_TIMEOUT_MS = 60_000;

function seedHistoricalDatabase(pathname: string, agentId?: string): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  using database = new DatabaseSync(pathname);
  // Exact schema bytes from v2026.7.35, before deletion history existed.
  const fixture = `../../test/fixtures/sqlite/openclaw-${agentId ? "agent" : "state"}-schema-v1.sql`;
  const schema = fs.readFileSync(new URL(fixture, import.meta.url), "utf8");
  database.exec(`BEGIN;\n${schema}\nPRAGMA user_version = 1;`);
  database
    .prepare("INSERT INTO schema_meta VALUES ('primary', ?, 1, ?, NULL, 1, 1)")
    .run(agentId ? "agent" : "global", agentId ?? null);
  database.exec("COMMIT;");
}

const writeJson = (pathname: string, value: unknown) =>
  fs.writeFileSync(pathname, JSON.stringify(value));

function readDatabase<T>(pathname: string, read: (database: DatabaseSync) => T): T {
  using database = new DatabaseSync(pathname, { readOnly: true });
  return read(database);
}

function readJsonColumn(pathname: string, sql: string, column: string) {
  return readDatabase(pathname, (database) =>
    JSON.parse(String(database.prepare(sql).get()?.[column])),
  );
}

// Let the file worker limit bound these full Doctor process runs.
it.for(["current", "historical-v1", "lost-journal"] as const)(
  "settles historical agent migration before auth and session repair with %s shared state",
  { timeout: getCliProcessTestTimeout(CHILD_TIMEOUT_MS, CHILD_TIMEOUT_MS) },
  async (sharedState, { expect, onTestFinished }) => {
    const root = fs.realpathSync(fixtures.createTempDir("doctor-agent-database-order-"));
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const sharedDatabasePath = path.join(stateDir, "state", "openclaw.sqlite");
    const sessionDir = path.join(
      sharedState === "lost-journal" ? stateDir : root,
      "custom-sessions",
    );
    const customDatabasePath = path.join(sessionDir, "openclaw-agent.sqlite");
    const agentIds = ["main", "worker"];
    const agentDatabasePaths = agentIds.map((agentId) =>
      path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite"),
    );
    const databasePaths = [...agentDatabasePaths, customDatabasePath];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_HOME: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_TEST_FAST: "1",
      OPENCLAW_TEST_RUNTIME_LOG: "1",
      NO_COLOR: "1",
    };
    for (const key of [
      "OPENCLAW_AGENT_DIR",
      "PI_CODING_AGENT_DIR",
      "OPENCLAW_GATEWAY_URL",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
    ]) {
      delete env[key];
    }
    const doctorResultOptions = { tmpdir: () => stateDir };
    let doctorResultPath: string | undefined;
    if (sharedState === "lost-journal") {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      // These helpers are unchanged from v2026.9.8's candidate Doctor driver.
      Object.assign(
        env,
        buildUpdateRehearsalPathEnv(stateDir),
        buildUpdateDoctorEnv({
          allowGatewayServiceRepair: false,
          allowGatewayActivation: false,
          serviceRepairPolicy: "external",
          deferConfiguredPluginInstallRepair: true,
        }),
        { OPENCLAW_DEV_SOURCE_ROOT: runtimeRoot },
      );
      for (const key of [
        ...SUPERVISOR_HINT_ENV_VARS,
        "OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META",
        "OPENCLAW_UPDATE_RUN_ID",
        "OPENCLAW_UPDATE_RUN_HANDOFF",
        "OPENCLAW_UPDATE_POST_CORE",
        "OPENCLAW_UPDATE_POST_CORE_CHANNEL",
        "OPENCLAW_UPDATE_POST_CORE_RESULT_PATH",
        "OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH",
        "OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS",
        "OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL",
        "OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH",
        "OPENCLAW_BUNDLED_PLUGINS_DIR",
        "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
        "OPENCLAW_GATEWAY_SERVICE_PID",
        "OPENCLAW_GATEWAY_PORT",
        "OPENCLAW_COMPATIBILITY_HOST_VERSION",
        "OPENCLAW_PROFILE",
        "OPENCLAW_DIAGNOSTICS_TIMELINE_PATH",
        "OPENCLAW_TEST_MINIMAL_GATEWAY",
      ]) {
        delete env[key];
      }
      doctorResultPath = createUpdatePostInstallDoctorResultPath(doctorResultOptions);
      env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV] = doctorResultPath;
    }
    if (sharedState === "historical-v1") {
      seedHistoricalDatabase(sharedDatabasePath);
    } else {
      openOpenClawStateDatabase({ env });
      closeOpenClawStateDatabaseForTest();
      if (sharedState === "lost-journal") {
        using database = new DatabaseSync(sharedDatabasePath);
        database.exec("DROP TABLE agent_deletion_journal;");
      }
    }
    agentIds.forEach((agentId, index) =>
      seedHistoricalDatabase(agentDatabasePaths[index]!, agentId),
    );
    // Custom session stores are inspected before repair without being registered by runtime opens.
    seedHistoricalDatabase(customDatabasePath, "main");
    for (const [index, agentId] of agentIds.entries()) {
      writeJson(
        path.join(path.dirname(agentDatabasePaths[index]!), "auth-profiles.json"),
        createAuthProfileStoreFixture({
          [`anthropic:${agentId}`]: createApiKeyCredential(
            "anthropic",
            `synthetic-${agentId}-credential`,
          ),
        }),
      );
    }
    const sessionId = "historical-session";
    writeJson(path.join(sessionDir, "sessions.json"), {
      "agent:main:history": { sessionId, label: "Preserved session", updatedAt: 1000 },
    });
    fs.writeFileSync(
      path.join(sessionDir, `${sessionId}.jsonl`),
      [
        {
          type: "session",
          id: sessionId,
          version: 3,
          timestamp: "2026-07-01T00:00:00Z",
          cwd: root,
        },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          message: { role: "user", content: "Preserved history" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const port = await acquireTestPortBlock({ offsets: [0] });
    try {
      writeJson(configPath, {
        ...(sharedState === "lost-journal" ? { plugins: { enabled: false } } : {}),
        agents:
          sharedState === "lost-journal"
            ? { ownership: "explicit", entries: { main: {}, worker: {} } }
            : { list: [{ id: "main", default: true }, { id: "worker" }] },
        gateway: { mode: "local", port: port.port },
        session: { store: path.join(sessionDir, "sessions.json") },
      });
      const agentDatabaseBytes = databasePaths.map((pathname) => fs.readFileSync(pathname));
      const args = [
        "doctor",
        "--fix",
        "--non-interactive",
        ...(sharedState === "lost-journal" ? [] : ["--yes"]),
        "--no-workspace-suggestions",
      ];
      const runDoctor = () =>
        fixtures.track(
          runBuiltRuntime(runtimeRoot, env, args, CHILD_TIMEOUT_MS, { onTestFinished }),
        );
      const first = await runDoctor();
      const output = stripVTControlCharacters(`${first.stdout}\n${first.stderr}`);
      if (sharedState === "lost-journal") {
        expect(first.code, output).toBe(1);
        expect(doctorResultPath).toBeDefined();
        const result = await consumeUpdatePostInstallDoctorResult(
          doctorResultPath!,
          doctorResultOptions,
        );
        expect(result, output).toMatchObject({
          status: "error",
          maintenanceRefusal: { kind: "data-at-risk", reason: "incomplete-migration" },
        });
        expect(output).toContain("Agent deletion journal reconstructed");
        expect(output).toContain("held back");
        expect(output).toContain("openclaw agents add");
        expect(output).toContain("--non-interactive");
        expect(output).not.toContain("Doctor complete.");
        for (const [index, pathname] of databasePaths.entries()) {
          expect(output).toContain(pathname);
          expect(fs.readFileSync(pathname)).toEqual(agentDatabaseBytes[index]);
        }
        return;
      }
      expect(first.code, output).toBe(0);
      expect(output).not.toMatch(
        /MediaMigrationRequiredError|run openclaw doctor --fix to migrate persisted media/u,
      );
      for (const pathname of databasePaths) {
        expect(
          readDatabase(
            pathname,
            (database) => database.prepare("PRAGMA user_version").get()?.user_version,
          ),
        ).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
      }
      const authMigration = output.indexOf("Migrated auth profile JSON");
      const sessionMigration = output.indexOf("Transcript events: imported=");
      const schemaMigration = output.lastIndexOf("Upgraded agent database schema");
      expect(schemaMigration).toBeGreaterThanOrEqual(0);
      expect(authMigration).toBeGreaterThan(schemaMigration);
      expect(sessionMigration).toBeGreaterThan(authMigration);

      const readPersistedState = () => ({
        sharedAuth: readJsonColumn(
          sharedDatabasePath,
          "SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.store'",
          "value_json",
        ),
        workerAuth: readJsonColumn(
          agentDatabasePaths[1]!,
          "SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'",
          "store_json",
        ),
        sessions: readDatabase(customDatabasePath, (database) =>
          database
            .prepare("SELECT session_key, entry_json FROM session_nodes ORDER BY session_key")
            .all(),
        ),
        transcript: readDatabase(
          customDatabasePath,
          (database) =>
            executeSqliteQuerySync(
              database,
              getNodeSqliteKysely<Pick<DB, "transcript_events">>(database)
                .selectFrom("transcript_events")
                .select(transcriptEventJsonSql(database).as("event_json"))
                .where("session_id", "=", sessionId)
                .orderBy("seq"),
            ).rows,
        ),
      });
      const migrated = readPersistedState();
      expect(migrated.sharedAuth.profiles["anthropic:main"]).toMatchObject({
        key: "synthetic-main-credential",
      });
      expect(migrated.workerAuth.profiles["anthropic:worker"]).toMatchObject({
        key: "synthetic-worker-credential",
      });
      expect(migrated.sessions).toContainEqual({
        session_key: "agent:main:history",
        entry_json: expect.any(String),
      });
      expect(
        JSON.parse(
          String(
            migrated.sessions.find((row) => row.session_key === "agent:main:history")?.entry_json,
          ),
        ),
      ).toMatchObject({ sessionId, label: "Preserved session" });
      expect(migrated.transcript.map((row) => JSON.parse(row.event_json))).toContainEqual(
        expect.objectContaining({ message: { role: "user", content: "Preserved history" } }),
      );

      const second = await runDoctor();
      const repeatedOutput = `${second.stdout}\n${second.stderr}`;
      expect(second.code, repeatedOutput).toBe(0);
      expect(repeatedOutput).not.toMatch(
        /Upgraded agent database schema|Migrated media persistence|Migrated auth profile JSON|Transcript events: imported=[1-9]/u,
      );
      expect(readPersistedState()).toEqual(migrated);
    } finally {
      await port.release();
    }
  },
);
