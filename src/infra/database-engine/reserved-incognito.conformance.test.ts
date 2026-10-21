import "../../test-utils/prepare-compiled-subprocesses.js";
import "./backup-worker.test-support.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { doctorDatabasePort } from "../../commands/doctor-database-port.js";
import { repairReservedIncognitoSessionKeys } from "../../commands/doctor-session-incognito-key-repair.js";
import { sessionSqlFixture } from "../../commands/doctor-session-sqlite.sql.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { databasePortManifestPath, type DatabasePortManifest } from "../database-port-recovery.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import type { EngineConnection } from "../sql-connection.js";
import { DoctorStateMigrationRefusalError } from "../state-migrations.messages.js";
import { installDatabaseProcessRole, withEngineStoreAdmission } from "./admission-scope.js";
import { agentPortProvider } from "./agent-port.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";
import { dropPortSchemas, files } from "./port-command.integration.test-support.js";
import { DatabasePortError } from "./port-command.worker.js";

const oldKey = "agent:main:dashboard:incognito-adoption";
const newKey = "agent:main:dashboard:legacy-incognito-adoption";

function seedAgent(db: EngineConnection, sessionKey = oldKey) {
  const sql = sessionSqlFixture(db);
  sql`INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at, parent_session_key) VALUES (${sessionKey}, 'legacy-session', ${JSON.stringify({ sessionId: "legacy-session", updatedAt: 1, parentSessionKey: sessionKey })}, 1, 1, ${sessionKey})`.run();
  sql`INSERT INTO session_windows (session_id, session_key, created_at, updated_at, parent_session_key) VALUES ('legacy-session', ${sessionKey}, 1, 1, ${sessionKey})`.run();
  sql`INSERT INTO board_tabs (session_key, tab_id, title, position, created_by, revision) VALUES (${sessionKey}, 'tab', 'Retained board', 0, 'user', 1)`.run();
  sql`INSERT INTO board_widgets (session_key, name, tab_id, content_kind, html, sha256, view_generation, revision, size_w, size_h, position, created_by, created_at, updated_at) VALUES (${sessionKey}, 'widget', 'tab', 'html', ${Buffer.from("retained")}, 'hash', 'view', 1, 1, 1, 0, 'user', 1, 1)`.run();
}

function seedShared(db: EngineConnection) {
  const sql = sessionSqlFixture(db);
  sql`INSERT INTO session_state_heads (session_key, agent_id, last_sequence, updated_at) VALUES (${oldKey}, 'main', 7, 1)`.run();
  sql`INSERT INTO session_watch_cursors (watcher_session_key, target_session_key, updated_at) VALUES (${oldKey}, ${oldKey}, 1)`.run();
}

function readAgent(db: EngineConnection) {
  return {
    nodes: db.prepare("SELECT * FROM session_nodes").all(),
    windows: db.prepare("SELECT * FROM session_windows").all(),
    tabs: db.prepare("SELECT * FROM board_tabs").all(),
    widgets: db.prepare("SELECT * FROM board_widgets").all(),
  };
}

function readShared(db: EngineConnection) {
  return {
    heads: db.prepare("SELECT * FROM session_state_heads").all(),
    watches: db.prepare("SELECT * FROM session_watch_cursors").all(),
    journal: db
      .prepare("SELECT * FROM state_leases WHERE scope = 'doctor-session-key-migration'")
      .all(),
  };
}

function assertAgentKey(db: EngineConnection, sessionKey = newKey) {
  expect(db.prepare("SELECT session_key, parent_session_key FROM session_nodes").get()).toEqual({
    session_key: sessionKey,
    parent_session_key: sessionKey,
  });
  for (const table of ["session_windows", "board_tabs", "board_widgets"]) {
    expect(db.prepare(`SELECT session_key FROM ${table}`).get()).toEqual({
      session_key: sessionKey,
    });
  }
  const row = db.prepare("SELECT entry_json FROM session_nodes").get() as { entry_json: string };
  expect(JSON.parse(row.entry_json)).toMatchObject({ parentSessionKey: sessionKey });
}

async function sourceArtifacts(paths: string[]) {
  const entries = await Promise.all(
    paths
      .flatMap((file) => [file, `${file}-wal`, `${file}-shm`])
      .map(async (file) => {
        if (!fs.existsSync(file)) {
          return [file, null] as const;
        }
        return [file, createHash("sha256").update(fs.readFileSync(file)).digest("hex")] as const;
      }),
  );
  return Object.fromEntries(entries);
}

describe.skipIf(!mixedAgentConnection)("reserved-incognito adoption preflight", () => {
  it.each(["agent and shared", "shared only", "agent without shared"])(
    "refuses unrepaired %s keys before capture and preserves the SQLite source",
    async (scope) => {
      await withOpenClawTestState(
        { scenario: "minimal", prefix: "reserved-incognito-port-" },
        async (state) => {
          const cfg = {
            database: {
              engine: "sqlite" as const,
              postgres: { connection: mixedAgentConnection! },
            },
          };
          await state.writeConfig(cfg);
          const agentPath = path.join(state.agentDir("main"), "openclaw-agent.sqlite");
          const sharedPath = state.statePath("state", "openclaw.sqlite");
          const sourceAgentKey = scope === "shared only" ? "agent:main:main" : oldKey;
          const expectedAgentKey = scope === "shared only" ? sourceAgentKey : newKey;
          const portOptions =
            scope === "agent without shared"
              ? { to: "postgres" as const }
              : { family: "agent" as const, to: "postgres" as const };
          if (scope === "agent without shared") {
            const descriptor = await agentPortProvider.loadDescriptor();
            fs.mkdirSync(path.dirname(agentPath), { recursive: true });
            using source = openNodeSqliteDatabase(agentPath);
            source.exec(descriptor.sqlite);
            source.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
              INSERT INTO schema_meta VALUES ('primary', 'agent', ${OPENCLAW_AGENT_SCHEMA_VERSION}, 'main', NULL, 1, 1);
              INSERT INTO session_key_contract (id, main_key, updated_at) VALUES (1, 'main', 0);`);
            seedAgent(source);
          } else {
            withEngineStoreAdmission(() => {
              runOpenClawAgentWriteTransaction(({ db }) => seedAgent(db, sourceAgentKey), {
                agentId: "main",
                env: state.env,
              });
              runOpenClawStateWriteTransaction(({ db }) => seedShared(db), { env: state.env });
            });
          }
          await cleanupSessionStateForTest({ stateDir: state.stateDir });
          expect(fs.existsSync(sharedPath)).toBe(scope !== "agent without shared");
          const original = await sourceArtifacts([agentPath, sharedPath, state.configPath]);
          const client = new Client({ connectionString: mixedAgentConnection });
          await client.connect();
          try {
            const error: unknown = await doctorDatabasePort(portOptions).catch(
              (caught: unknown) => caught,
            );
            expect(error).toBeInstanceOf(DatabasePortError);
            expect(error).toMatchObject({ code: "RESERVED_INCOGNITO_SESSION_KEYS" });
            expect(String(error)).toContain("openclaw doctor --fix");
            expect(await sourceArtifacts([agentPath, sharedPath, state.configPath])).toEqual(
              original,
            );
            {
              using agentSource = openNodeSqliteDatabase(agentPath, { readOnly: true });
              expect(agentSource.prepare("SELECT session_key FROM session_nodes").get()).toEqual({
                session_key: sourceAgentKey,
              });
              if (scope !== "agent without shared") {
                using sharedSource = openNodeSqliteDatabase(sharedPath, { readOnly: true });
                expect(
                  sharedSource.prepare("SELECT session_key FROM session_state_heads").get(),
                ).toEqual({ session_key: oldKey });
              } else {
                expect(fs.existsSync(sharedPath)).toBe(false);
              }
            }
            expect(fs.existsSync(databasePortManifestPath(state.stateDir))).toBe(false);
            const recovery = state.statePath("recovery", "database-port");
            expect(fs.existsSync(recovery) ? await files(recovery) : []).toEqual([]);

            installDatabaseProcessRole("cli-oneshot");
            await expect(
              repairReservedIncognitoSessionKeys({ apply: true, cfg, env: state.env }),
            ).resolves.toEqual({ found: 1, repaired: 1 });
            withEngineStoreAdmission(() => {
              assertAgentKey(
                openOpenClawAgentDatabase({ agentId: "main", env: state.env }).db,
                expectedAgentKey,
              );
              expect(readShared(openOpenClawStateDatabase({ env: state.env }).db)).toMatchObject({
                heads:
                  scope === "agent without shared"
                    ? []
                    : [{ session_key: newKey, last_sequence: 7 }],
                watches:
                  scope === "agent without shared"
                    ? []
                    : [{ watcher_session_key: newKey, target_session_key: newKey }],
                journal: [],
              });
            });
            await cleanupSessionStateForTest({ stateDir: state.stateDir });
            const result = await doctorDatabasePort(portOptions);
            expect(result).toMatchObject({
              phase: "complete",
              engine: "postgres",
              stores:
                scope === "agent without shared"
                  ? expect.arrayContaining([agentPath, sharedPath])
                  : [agentPath],
            });
            assert("manifest" in result);
            const manifest = JSON.parse(
              fs.readFileSync(result.manifest, "utf8"),
            ) as DatabasePortManifest;
            const target = manifest.targets.find(
              ({ original: source }) => source.engine === "sqlite" && source.path === agentPath,
            )?.intended;
            assert(target?.engine === "postgres");
            for (const table of [
              "session_nodes",
              "session_windows",
              "board_tabs",
              "board_widgets",
            ]) {
              expect(
                (await client.query(`SELECT session_key FROM "${target.namespace}".${table}`)).rows,
              ).toEqual([{ session_key: expectedAgentKey }]);
            }
          } finally {
            const recovery = state.statePath("recovery", "database-port");
            if (fs.existsSync(recovery)) {
              await dropPortSchemas(
                client,
                (await files(recovery)).filter((file) => path.basename(file) === "manifest.json"),
              );
            }
            await client.end();
          }
        },
      );
    },
  );
});

describe.each(["sqlite", "postgres"] as const)("%s reserved-incognito Doctor", (engine) => {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)("repair boundary", () => {
    useMixedAgentPair(engine, engine);

    it("repairs SQLite references or refuses PostgreSQL before any data or journal write", async () => {
      const agent = withEngineStoreAdmission(() =>
        runOpenClawAgentWriteTransaction(
          (database) => {
            seedAgent(database.db);
            return database;
          },
          { agentId: "main" },
        ),
      );
      const shared = withEngineStoreAdmission(() =>
        runOpenClawStateWriteTransaction((database) => {
          seedShared(database.db);
          return database;
        }),
      );
      const before = withEngineStoreAdmission(() => ({
        agent: readAgent(agent.db),
        shared: readShared(shared.db),
      }));
      installDatabaseProcessRole("cli-oneshot");
      const repair = (apply: boolean) =>
        repairReservedIncognitoSessionKeys({ apply, cfg: {}, env: process.env });
      if (engine === "postgres") {
        for (const apply of [true, false]) {
          const error: unknown = await repair(apply).catch((caught: unknown) => caught);
          expect(error).toBeInstanceOf(DoctorStateMigrationRefusalError);
          expect(error).toMatchObject({ code: "RESERVED_INCOGNITO_SESSION_KEYS" });
          expect(String(error)).toMatch(/re-adopt.*repaired SQLite/i);
          expect(
            withEngineStoreAdmission(() => ({
              agent: readAgent(agent.db),
              shared: readShared(shared.db),
            })),
          ).toEqual(before);
        }
      } else {
        await expect(repair(false)).resolves.toEqual({ found: 1, repaired: 0 });
        await expect(repair(true)).resolves.toEqual({ found: 1, repaired: 1 });
        withEngineStoreAdmission(() => {
          assertAgentKey(agent.db);
          expect(readShared(shared.db)).toMatchObject({
            heads: [{ session_key: newKey, last_sequence: 7 }],
            watches: [{ watcher_session_key: newKey, target_session_key: newKey }],
            journal: [],
          });
        });
        await expect(repair(true)).resolves.toEqual({ found: 0, repaired: 0 });
      }
    });
  });
});
