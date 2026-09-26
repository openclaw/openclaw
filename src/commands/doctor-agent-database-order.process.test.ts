import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stripVTControlCharacters } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { getCliProcessTestTimeout } from "../cli/cli-process-child.test-helpers.js";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
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

function seedHistoricalSharedDatabase(pathname: string): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  const database = new DatabaseSync(pathname);
  try {
    // Exact schema and metadata written by v2026.7.35, before deletion history existed.
    database.exec(
      fs.readFileSync(
        new URL("../../test/fixtures/sqlite/openclaw-state-schema-v1.sql", import.meta.url),
        "utf8",
      ),
    );
    database.exec("PRAGMA user_version = 1;");
    database
      .prepare("INSERT INTO schema_meta VALUES ('primary', 'global', 1, NULL, NULL, 1, 1)")
      .run();
  } finally {
    database.close();
  }
}

function seedHistoricalAgentDatabase(pathname: string, agentId: string): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  const database = new DatabaseSync(pathname);
  try {
    // Exact schema bytes from v2026.7.35, whose agent databases used user_version=1.
    database.exec(
      fs.readFileSync(
        new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v1.sql", import.meta.url),
        "utf8",
      ),
    );
    database.exec("PRAGMA user_version = 1;");
    database
      .prepare("INSERT INTO schema_meta VALUES ('primary', 'agent', 1, ?, NULL, 1, 1)")
      .run(agentId);
  } finally {
    database.close();
  }
}

function readDatabase<T>(pathname: string, read: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(pathname, { readOnly: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
}

it.each(["current", "historical-v1", "lost-journal"] as const)(
  "settles historical agent migration before auth and session repair with %s shared state",
  async (sharedState) => {
    const root = fs.realpathSync(fixtures.createTempDir("doctor-agent-database-order-"));
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const sharedDatabasePath = path.join(stateDir, "state", "openclaw.sqlite");
    const sessionDir = path.join(root, "custom-sessions");
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
    if (sharedState === "historical-v1") {
      seedHistoricalSharedDatabase(sharedDatabasePath);
    } else {
      openOpenClawStateDatabase({ env });
      closeOpenClawStateDatabaseForTest();
      if (sharedState === "lost-journal") {
        const database = new DatabaseSync(sharedDatabasePath);
        try {
          database.exec("DROP TABLE agent_deletion_journal;");
        } finally {
          database.close();
        }
      }
    }
    agentIds.forEach((agentId, index) =>
      seedHistoricalAgentDatabase(agentDatabasePaths[index]!, agentId),
    );
    // Custom session stores are inspected before repair without being registered by runtime opens.
    seedHistoricalAgentDatabase(customDatabasePath, "main");
    for (const [index, agentId] of agentIds.entries()) {
      fs.writeFileSync(
        path.join(path.dirname(agentDatabasePaths[index]!), "auth-profiles.json"),
        JSON.stringify({
          version: 1,
          profiles: {
            [`anthropic:${agentId}`]: {
              type: "api_key",
              provider: "anthropic",
              key: `synthetic-${agentId}-credential`,
            },
          },
        }),
      );
    }
    const sessionId = "historical-session";
    fs.writeFileSync(
      path.join(sessionDir, "sessions.json"),
      JSON.stringify({
        "agent:main:history": { sessionId, label: "Preserved session", updatedAt: 1000 },
      }),
    );
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
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          agents:
            sharedState === "lost-journal"
              ? { ownership: "explicit", entries: { main: {}, worker: {} } }
              : { list: [{ id: "main", default: true }, { id: "worker" }] },
          gateway: { mode: "local", port: port.port },
          session: { store: path.join(sessionDir, "sessions.json") },
        }),
      );
      const agentDatabaseBytes = databasePaths.map((pathname) => fs.readFileSync(pathname));
      const args = ["doctor", "--fix", "--non-interactive", "--yes", "--no-workspace-suggestions"];
      const first = await fixtures.track(runBuiltRuntime(runtimeRoot, env, args, CHILD_TIMEOUT_MS));
      const output = stripVTControlCharacters(`${first.stdout}\n${first.stderr}`);
      if (sharedState === "lost-journal") {
        expect(first.code, output).toBe(1);
        expect(output).toContain("agent-deletion-journal");
        expect(output).toContain("held back");
        expect(output).toContain("openclaw agents add");
        expect(output).toContain("--non-interactive");
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
        sharedAuth: readDatabase(sharedDatabasePath, (database) =>
          JSON.parse(
            String(
              database
                .prepare(
                  "SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.store'",
                )
                .get()?.value_json,
            ),
          ),
        ),
        workerAuth: readDatabase(agentDatabasePaths[1]!, (database) =>
          JSON.parse(
            String(
              database
                .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'")
                .get()?.store_json,
            ),
          ),
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

      const second = await fixtures.track(
        runBuiltRuntime(runtimeRoot, env, args, CHILD_TIMEOUT_MS),
      );
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
  getCliProcessTestTimeout(CHILD_TIMEOUT_MS, CHILD_TIMEOUT_MS),
);
