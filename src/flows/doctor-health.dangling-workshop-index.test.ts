import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { doctorCommand } from "../commands/doctor.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { createDanglingSkillWorkshopReviewIndex } from "../state/openclaw-state-db-corruption.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDoctorConfig, createDoctorRuntime, mocks } from "./doctor-health.test-support.js";

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
    ...createDoctorConfig(state),
    plugins: { enabled: false },
    ...(session ? { session } : {}),
  });
}

function executeSql(file: string, sql: string) {
  const { DatabaseSync } = requireNodeSqlite();
  using db = new DatabaseSync(file);
  db.exec(sql);
}

function expectDatabase(file: string, queries: Record<string, unknown>) {
  const { DatabaseSync } = requireNodeSqlite();
  using db = new DatabaseSync(file, { readOnly: true });
  for (const [sql, expected] of Object.entries(queries)) {
    expect(db.prepare(sql).all(), sql).toEqual(expected);
  }
}

const repairOptions = { repair: true, nonInteractive: true };
const orphan = { task_id: "orphan-preserved", requester_origin_json: "preserve orphan payload" };
async function seedState(state: OpenClawTestState) {
  await writeConfig(state);
  return openOpenClawStateDatabase({ env: state.env });
}

it("preserves known damaged state before backing up and migrating an older agent", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = await seedState(state);
    const agentPath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    executeSql(
      agentPath,
      `${fs.readFileSync(
        new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v19.sql", import.meta.url),
        "utf8",
      )}
      PRAGMA user_version = 19;
      INSERT INTO schema_meta
        (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
        VALUES ('primary', 'agent', 19, 'main', '2026.9.4', 1, 1);
    `,
    );
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
    createDanglingSkillWorkshopReviewIndex(database.path);
    const runtime = createDoctorRuntime();
    await doctorCommand(runtime, repairOptions);
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
    expectDatabase(database.path, {
      "SELECT name FROM sqlite_schema WHERE name IN ('skill_workshop_collection_reviews', 'idx_skill_workshop_collection_reviews_workspace_time')":
        [],
      "PRAGMA user_version": [{ user_version: OPENCLAW_STATE_SCHEMA_VERSION }],
      "PRAGMA integrity_check": [{ integrity_check: "ok" }],
      "PRAGMA foreign_key_check": [],
    });
    const directory = path.dirname(database.path);
    const dirs = fs
      .readdirSync(directory)
      .filter((name) => name.startsWith("openclaw-task-delivery-recovery-"));
    expect(dirs).toHaveLength(1);
    const recoveryPath = path.join(directory, dirs[0]!);
    const recovered = fs.readFileSync(path.join(recoveryPath, "orphan-rows.jsonl"), "utf8");
    expect(JSON.parse(recovered)).toMatchObject(orphan);
    expectDatabase(path.join(recoveryPath, "database.sqlite"), {
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
    });
  });
});

it("refuses a newer custom agent schema before changing the malformed source", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = await seedState(state);
    const customPath = state.path("custom", "sessions.sqlite");
    fs.mkdirSync(path.dirname(customPath));
    executeSql(
      customPath,
      `
          PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};
          CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, agent_id TEXT);
          INSERT INTO schema_meta VALUES ('primary', 'main');
        `,
    );
    await writeConfig(state, { store: customPath });
    await closeOpenClawStateDatabaseAsync();
    createDanglingSkillWorkshopReviewIndex(database.path);
    const before = fs.readFileSync(database.path);
    const configBefore = fs.readFileSync(state.configPath);

    await expect(doctorCommand(createDoctorRuntime(), repairOptions)).rejects.toThrow(/newer/);

    expect(fs.readFileSync(database.path)).toEqual(before);
    expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
    expect(mocks.runContributions).not.toHaveBeenCalled();
    expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
  });
});
