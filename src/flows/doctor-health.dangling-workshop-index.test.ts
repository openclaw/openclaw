import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { doctorCommand } from "../commands/doctor.js";
import { runClientCredentialOperation } from "../infra/client-credential-store.js";
import { generateStoredDeviceIdentity } from "../infra/device-identity-material.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import { seedNativeVersionZeroState } from "../state/native-version-zero.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDoctorRuntime, mocks } from "./doctor-health.test-support.js";

// Keep the real Doctor config/migration chain; the shared harness isolates service and UI checks.
vi.doUnmock("../commands/doctor-config-flow.js");
vi.doUnmock("../commands/doctor-prompter.js");
vi.doUnmock("../commands/doctor/shared/plugin-runtime-symlinks.js");

beforeEach(() => {
  mocks.packageRoot.mockReturnValue(undefined);
  mocks.outro.mockClear();
  mocks.runContributions.mockReset();
});
afterEach(() => vi.restoreAllMocks());

function writeConfig(state: OpenClawTestState, session?: { store: string }) {
  return state.writeConfig({
    agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
    gateway: { mode: "local" },
    plugins: { enabled: false },
    ...(session ? { session } : {}),
  });
}

function editDatabase(file: string, edit: (db: DatabaseSync) => void) {
  const { DatabaseSync } = requireNodeSqlite();
  using db = new DatabaseSync(file);
  edit(db);
}

function expectDatabase(file: string, queries: Record<string, unknown>) {
  const { DatabaseSync } = requireNodeSqlite();
  using db = new DatabaseSync(file, { readOnly: true });
  for (const [sql, expected] of Object.entries(queries)) {
    expect(db.prepare(sql).all(), sql).toEqual(expected);
  }
}

function recoveryDirs(file: string) {
  return fs
    .readdirSync(path.dirname(file))
    .filter((name) => name.startsWith("openclaw-task-delivery-recovery-"));
}

const repairOptions = { repair: true, nonInteractive: true };
const orphan = { task_id: "orphan-preserved", requester_origin_json: "preserve orphan payload" };
const runtimeRunIndex = ["runtime", "run_id", "source_id", "created_at", "task_id"].map((name) => ({
  name,
}));

async function repair() {
  const runtime = createDoctorRuntime();
  await doctorCommand(runtime, repairOptions);
  expect(runtime.exit).not.toHaveBeenCalled();
  expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
  return runtime;
}

async function seedState(state: OpenClawTestState) {
  await writeConfig(state);
  const database = openOpenClawStateDatabase({ env: state.env });
  database.db.exec(`
    CREATE TABLE IF NOT EXISTS skill_workshop_collection_reviews (review_id TEXT NOT NULL PRIMARY KEY, owner_agent_id TEXT NOT NULL, backup_id TEXT NOT NULL, create_time INTEGER NOT NULL, kept_names_json TEXT NOT NULL, written_names_json TEXT NOT NULL, dropped_json TEXT NOT NULL) STRICT;
    INSERT INTO skill_workshop_collection_reviews (
      review_id, owner_agent_id, backup_id, create_time, kept_names_json, written_names_json, dropped_json
    ) VALUES ('review-preserved', 'main', 'backup-preserved', 1, '[]', '[]', '[]');
  `);
  return database;
}

function damageWorkshopIndex(databasePath: string): void {
  editDatabase(databasePath, (database) => {
    database.exec(
      "CREATE TABLE IF NOT EXISTS skill_workshop_collection_reviews (review_id TEXT NOT NULL PRIMARY KEY, owner_agent_id TEXT NOT NULL, backup_id TEXT NOT NULL, create_time INTEGER NOT NULL, kept_names_json TEXT NOT NULL, written_names_json TEXT NOT NULL, dropped_json TEXT NOT NULL) STRICT; CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time ON skill_workshop_collection_reviews(review_id, create_time DESC);",
    );
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database.exec(
      `UPDATE sqlite_schema
            SET sql = 'CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time
                         ON skill_workshop_collection_reviews(workspace_dir, create_time DESC, review_id DESC)'
          WHERE type = 'index' AND name = 'idx_skill_workshop_collection_reviews_workspace_time'`,
    );
    const schemaVersion = readSqliteNumberPragma(database, "schema_version");
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
  });
}

it("adopts native version-zero state without requiring orphan-recovery metadata", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await writeConfig(state);
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const identity = generateStoredDeviceIdentity(1);
    editDatabase(databasePath, (db) => {
      seedNativeVersionZeroState(db, true);
      db.prepare(
        "UPDATE device_identities SET device_id=?, public_key_pem=?, private_key_pem=? WHERE identity_key='node'",
      ).run(identity.deviceId, identity.publicKeyPem, identity.privateKeyPem);
    });
    await repair();
    expectDatabase(databasePath, {
      "PRAGMA user_version": [{ user_version: OPENCLAW_STATE_SCHEMA_VERSION }],
      "SELECT role, schema_version FROM schema_meta WHERE meta_key = 'primary'": [
        { role: "global", schema_version: OPENCLAW_STATE_SCHEMA_VERSION },
      ],
      "SELECT name FROM sqlite_schema WHERE name='device_identities'": [],
      "SELECT raw_json FROM exec_approvals_config WHERE config_key = 'current'": [
        { raw_json: "{}" },
      ],
    });
    expect(
      runClientCredentialOperation(state.env, { kind: "identity.read", identity_key: "node" }),
    ).toEqual({
      kind: "identity",
      identity: {
        identity_key: "node",
        device_id: identity.deviceId,
        public_key_pem: identity.publicKeyPem,
        private_key_pem: identity.privateKeyPem,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    });
    expect(recoveryDirs(databasePath)).toEqual([]);
  });
});

it("preserves known damaged state before backing up and migrating an older agent", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = await seedState(state);
    const agentPath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    editDatabase(agentPath, (agent) => {
      agent.exec(
        fs.readFileSync(
          new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v19.sql", import.meta.url),
          "utf8",
        ),
      );
      agent.exec(`
        PRAGMA user_version = 19;
        INSERT INTO schema_meta
          (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
          VALUES ('primary', 'agent', 19, 'main', '2026.9.4', 1, 1);
        INSERT INTO cache_entries(scope,key,value_json,expires_at,updated_at)
          VALUES ('upgrade-proof','retained','{"keep":true}',NULL,7);
      `);
    });
    registerOpenClawAgentDatabase({
      agentId: "main",
      path: agentPath,
      env: state.env,
      schemaVersion: 19,
    });
    database.db.exec(`
      DROP INDEX idx_task_runs_runtime_run;
      PRAGMA foreign_keys = OFF;
      INSERT INTO task_delivery_state (task_id, requester_origin_json)
        VALUES ('orphan-preserved', 'preserve orphan payload');
      PRAGMA foreign_keys = ON;
    `);
    await closeOpenClawStateDatabaseAsync();
    damageWorkshopIndex(database.path);
    const runtime = await repair();
    expect(runtime.log).toHaveBeenCalledWith("Removed dangling legacy Skill Workshop review index");
    expectDatabase(database.path, {
      "SELECT name FROM sqlite_schema WHERE name IN ('skill_workshop_collection_reviews', 'idx_skill_workshop_collection_reviews_workspace_time')":
        [],
      "SELECT name FROM pragma_index_info('idx_task_runs_runtime_run')": runtimeRunIndex,
      "PRAGMA user_version": [{ user_version: OPENCLAW_STATE_SCHEMA_VERSION }],
      "PRAGMA integrity_check": [{ integrity_check: "ok" }],
      "PRAGMA foreign_key_check": [],
    });
    const dirs = recoveryDirs(database.path);
    expect(dirs).toHaveLength(1);
    const recovered = fs.readFileSync(
      path.join(path.dirname(database.path), dirs[0]!, "orphan-rows.jsonl"),
      "utf8",
    );
    expect(JSON.parse(recovered)).toMatchObject(orphan);
    expectDatabase(path.join(path.dirname(database.path), dirs[0]!, "database.sqlite"), {
      "SELECT task_id, requester_origin_json FROM task_delivery_state": [orphan],
    });
    for (const sourcePath of [database.path, agentPath]) {
      const backups = fs
        .readdirSync(path.dirname(sourcePath))
        .filter((name) => name.startsWith(`${path.basename(sourcePath)}.pre-startup-migration-`));
      expect(backups).toHaveLength(1);
      expectDatabase(path.join(path.dirname(sourcePath), backups[0]!), {
        "PRAGMA foreign_key_check": [],
        "PRAGMA user_version": [
          { user_version: sourcePath === agentPath ? 19 : OPENCLAW_STATE_SCHEMA_VERSION },
        ],
      });
    }
    expectDatabase(agentPath, {
      "PRAGMA user_version": [{ user_version: OPENCLAW_AGENT_SCHEMA_VERSION }],
      "SELECT value_json, updated_at FROM cache_entries WHERE scope = 'upgrade-proof'": [
        { value_json: '{"keep":true}', updated_at: 7 },
      ],
    });
  });
});

it("refuses a newer custom agent schema before changing the malformed source", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = await seedState(state);
    const customPath = state.path("custom", "sessions.sqlite");
    fs.mkdirSync(path.dirname(customPath));
    editDatabase(customPath, (custom) =>
      custom.exec(`
          PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};
          CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, agent_id TEXT);
          INSERT INTO schema_meta VALUES ('primary', 'main');
        `),
    );
    await writeConfig(state, { store: customPath });
    await closeOpenClawStateDatabaseAsync();
    damageWorkshopIndex(database.path);
    const before = fs.readFileSync(database.path);
    const configBefore = fs.readFileSync(state.configPath);

    await expect(doctorCommand(createDoctorRuntime(), repairOptions)).rejects.toThrow(/newer/);

    expect(fs.readFileSync(database.path)).toEqual(before);
    expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
    expect(mocks.runContributions).not.toHaveBeenCalled();
    expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
  });
});
