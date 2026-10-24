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
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { seedOpenClawAgentSchemaV21 } from "../../state/openclaw-agent-schema-v21.test-support.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { databasePortManifestPath, type DatabasePortManifest } from "../database-port-recovery.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import type { EngineConnection } from "../sql-connection.js";
import { retireSqliteDatabaseAdmissionForPath } from "../sqlite-database-admission.js";
import { DoctorStateMigrationRefusalError } from "../state-migrations.messages.js";
import { installDatabaseProcessRole, withEngineStoreAdmission } from "./admission-scope.js";
import { agentPortProvider } from "./agent-port.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";
import {
  dropPortSchemas,
  files,
  fixture as portFixture,
} from "./port-command.integration.test-support.js";
import { DatabasePortError } from "./port-command.worker.js";

const oldKey = "agent:main:dashboard:incognito-adoption";
const newKey = "agent:main:dashboard:legacy-incognito-adoption";

function seedAgent(db: EngineConnection, sessionKey = oldKey, completionOwnerSessionKey?: string) {
  const sql = sessionSqlFixture(db);
  sql`INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at, parent_session_key) VALUES (${sessionKey}, 'legacy-session', ${JSON.stringify({ sessionId: "legacy-session", updatedAt: 1, parentSessionKey: sessionKey, ...(completionOwnerSessionKey ? { completionOwnerSessionKey } : {}) })}, 1, 1, ${sessionKey})`.run();
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

function assertAgentKey(
  db: EngineConnection,
  sessionKey = newKey,
  completionOwnerSessionKey?: string,
) {
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
  expect(JSON.parse(row.entry_json)).toMatchObject({
    parentSessionKey: sessionKey,
    ...(completionOwnerSessionKey ? { completionOwnerSessionKey } : {}),
  });
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
  it.each([
    "agent and shared",
    "shared only",
    "agent without shared",
    "JSON reference only",
    "v21 inline reference",
  ])("refuses unrepaired %s keys before capture and preserves the SQLite source", async (scope) => {
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
        const jsonOnly = scope === "JSON reference only";
        const historical = scope === "v21 inline reference";
        const withoutShared = scope === "agent without shared" || historical;
        const sourceAgentKey =
          scope === "shared only" || jsonOnly || historical ? "agent:main:main" : oldKey;
        const expectedAgentKey = scope === "shared only" || jsonOnly ? sourceAgentKey : newKey;
        const portOptions = withoutShared
          ? { to: "postgres" as const }
          : { family: "agent" as const, to: "postgres" as const };
        if (withoutShared) {
          fs.mkdirSync(path.dirname(agentPath), { recursive: true });
          using source = openNodeSqliteDatabase(agentPath);
          if (historical) {
            seedOpenClawAgentSchemaV21(source);
            source
              .prepare(
                "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, 'legacy-session', ?, 1)",
              )
              .run(
                sourceAgentKey,
                JSON.stringify({
                  sessionId: "legacy-session",
                  updatedAt: 1,
                  systemPromptReport: { sessionKey: oldKey },
                }),
              );
            source
              .prepare(
                "INSERT INTO session_windows (session_id, session_key, created_at, updated_at) VALUES ('legacy-session', ?, 1, 1)",
              )
              .run(sourceAgentKey);
          } else {
            const descriptor = await agentPortProvider.loadDescriptor();
            source.exec(descriptor.sqlite);
            source.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
                INSERT INTO schema_meta VALUES ('primary', 'agent', ${OPENCLAW_AGENT_SCHEMA_VERSION}, 'main', NULL, 1, 1);
                INSERT INTO session_key_contract (id, main_key, updated_at) VALUES (1, 'main', 0);`);
            seedAgent(source);
          }
        } else {
          withEngineStoreAdmission(() => {
            runOpenClawAgentWriteTransaction(
              ({ db }) => seedAgent(db, sourceAgentKey, jsonOnly ? oldKey : undefined),
              {
                agentId: "main",
                env: state.env,
              },
            );
            if (jsonOnly) {
              openOpenClawStateDatabase({ env: state.env });
            } else {
              runOpenClawStateWriteTransaction(({ db }) => seedShared(db), { env: state.env });
            }
          });
        }
        await cleanupSessionStateForTest({ stateDir: state.stateDir });
        expect(fs.existsSync(sharedPath)).toBe(!withoutShared);
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
            if (jsonOnly || historical) {
              const entry = agentSource.prepare("SELECT entry_json FROM session_nodes").get() as {
                entry_json: string;
              };
              expect(JSON.parse(entry.entry_json)).toMatchObject(
                historical
                  ? { systemPromptReport: { sessionKey: oldKey } }
                  : { completionOwnerSessionKey: oldKey },
              );
            }
            if (!withoutShared) {
              using sharedSource = openNodeSqliteDatabase(sharedPath, { readOnly: true });
              expect(
                sharedSource.prepare("SELECT session_key FROM session_state_heads").get(),
              ).toEqual(jsonOnly ? undefined : { session_key: oldKey });
            } else {
              expect(fs.existsSync(sharedPath)).toBe(false);
            }
          }
          expect(fs.existsSync(databasePortManifestPath(state.stateDir))).toBe(false);
          const recovery = state.statePath("recovery", "database-port");
          expect(fs.existsSync(recovery) ? await files(recovery) : []).toEqual([]);

          // Missing deletion history has its own Doctor safety hold; this case proves refusal only.
          if (withoutShared) {
            return;
          }

          installDatabaseProcessRole("cli-oneshot");
          await expect(
            repairReservedIncognitoSessionKeys({ apply: true, cfg, env: state.env }),
          ).resolves.toEqual({ found: 1, repaired: 1 });
          withEngineStoreAdmission(() => {
            assertAgentKey(
              openOpenClawAgentDatabase({ agentId: "main", env: state.env }).db,
              expectedAgentKey,
              jsonOnly ? newKey : undefined,
            );
            expect(readShared(openOpenClawStateDatabase({ env: state.env }).db)).toMatchObject({
              heads: jsonOnly ? [] : [{ session_key: newKey, last_sequence: 7 }],
              watches: jsonOnly
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
            stores: [agentPath],
          });
          assert("manifest" in result);
          const manifest = JSON.parse(
            fs.readFileSync(result.manifest, "utf8"),
          ) as DatabasePortManifest;
          const target = manifest.targets.find(
            ({ original: source }) => source.engine === "sqlite" && source.path === agentPath,
          )?.intended;
          assert(target?.engine === "postgres");
          for (const table of ["session_nodes", "session_windows", "board_tabs", "board_widgets"]) {
            expect(
              (await client.query(`SELECT session_key FROM "${target.namespace}".${table}`)).rows,
            ).toEqual([{ session_key: expectedAgentKey }]);
          }
          if (jsonOnly) {
            const {
              rows: [entry],
            } = await client.query<{ entry_json: string }>(
              `SELECT entry_json FROM "${target.namespace}".session_nodes`,
            );
            assert(entry);
            expect(JSON.parse(entry.entry_json)).toMatchObject({
              completionOwnerSessionKey: newKey,
            });
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
  });

  it("ports an unrelated workboard family while shared legacy references remain unchanged", async () => {
    await portFixture(async ({ state, source }) => {
      const shared = withEngineStoreAdmission(() =>
        runOpenClawStateWriteTransaction(
          (database) => {
            seedShared(database.db);
            return database;
          },
          { env: state.env },
        ),
      );
      const before = withEngineStoreAdmission(() => readShared(shared.db));
      await expect(
        doctorDatabasePort({ family: "workboard", to: "postgres" }),
      ).resolves.toMatchObject({
        phase: "complete",
        engine: "postgres",
        stores: [source],
      });
      expect(
        withEngineStoreAdmission(() =>
          readShared(openOpenClawStateDatabase({ env: state.env }).db),
        ),
      ).toEqual(before);
    }, true);
  });
});

describe.skipIf(!mixedAgentConnection)("reserved-incognito PG admission refusal", () => {
  useMixedAgentPair("sqlite", "postgres");

  it("preserves SQLite shared state and its journal when the PG agent cannot be admitted", async () => {
    const agent = withEngineStoreAdmission(() =>
      runOpenClawAgentWriteTransaction(
        (database) => {
          seedAgent(database.db, "agent:main:main");
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
    const facts = getPostgresPhysicalFacts(agent.db);
    assert(facts);
    const before = withEngineStoreAdmission(() => readShared(shared.db));
    installDatabaseProcessRole("cli-oneshot");
    await closeOpenClawAgentDatabaseByPathAsync(agent.path);
    retireSqliteDatabaseAdmissionForPath(agent.path);
    const client = new Client({ connectionString: mixedAgentConnection });
    await client.connect();
    try {
      await client.query(
        `UPDATE "${facts.namespace}".schema_meta SET agent_id = 'different' WHERE meta_key = 'primary'`,
      );
      expect(() =>
        withEngineStoreAdmission(() =>
          withOpenClawAgentDatabaseReadOnly(() => undefined, { agentId: "main", path: agent.path }),
        ),
      ).toThrow(/belongs to agent different; requested agent main/);
      const error: unknown = await repairReservedIncognitoSessionKeys({
        apply: true,
        cfg: {},
        env: process.env,
        targets: [{ agentId: "main", sqlitePath: agent.path, storePath: agent.path }],
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DoctorStateMigrationRefusalError);
      expect(error).toMatchObject({ code: "RESERVED_INCOGNITO_SESSION_KEYS" });
      expect(String(error)).toMatch(/re-adopt.*repaired SQLite/i);
      expect(withEngineStoreAdmission(() => readShared(shared.db))).toEqual(before);
    } finally {
      await client.query(
        `UPDATE "${facts.namespace}".schema_meta SET agent_id = 'main' WHERE meta_key = 'primary'`,
      );
      await client.end();
    }
  });
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
