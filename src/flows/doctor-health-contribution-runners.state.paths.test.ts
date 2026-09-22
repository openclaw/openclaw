import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { updateStateSchemaVersionsMatch } from "../infra/update-candidate-state.js";
import {
  OPENCLAW_STATE_SCHEMA_VERSION,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db-contract.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { resolveOpenClawRegisteredAgentDatabasePath } from "../state/openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { runStateIntegrityHealth } from "./doctor-health-contribution-runners.state.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

const fixture = vi.hoisted(() => ({
  database: undefined as OpenClawStateDatabase | undefined,
  beforeAdmission: undefined as (() => void) | undefined,
  note: vi.fn(),
}));

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, default: actual.win32 };
});
vi.mock("../state/openclaw-state-db.js", () => ({
  runOpenClawStateWriteTransaction: <T>(operation: (database: OpenClawStateDatabase) => T): T => {
    const database = fixture.database;
    if (!database) {
      throw new Error("Missing Doctor database fixture");
    }
    fixture.beforeAdmission?.();
    return runSqliteImmediateTransactionSync(database.db, () => operation(database));
  },
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: fixture.note }));
vi.mock("../commands/doctor-state-integrity.js", () => ({ noteStateIntegrity: vi.fn() }));
vi.mock("../commands/backup-health.js", () => ({ noteBackupDoctorHint: vi.fn() }));

const relative = String.raw`agents\main\agent\openclaw-agent.sqlite`;

function seedDatabase(stateDir = String.raw`C:\synthetic\state`) {
  const db = new (requireNodeSqlite().DatabaseSync)(":memory:");
  db.exec(OPENCLAW_STATE_SCHEMA_SQL);
  db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`);
  db.prepare(
    "INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at) VALUES ('primary', 'global', ?, 1, 1)",
  ).run(OPENCLAW_STATE_SCHEMA_VERSION);
  const database = {
    db,
    path: path.join(stateDir, "state", "openclaw.sqlite"),
    walMaintenance: { checkpoint: () => true, close: () => true },
  };
  fixture.database = database;
  const queries = getNodeSqliteKysely<Pick<DB, "agent_databases" | "update_runs">>(db);
  const namespaced = path.toNamespacedPath(path.join(stateDir, relative));
  const external = path.toNamespacedPath(String.raw`D:\other\openclaw-agent.sqlite`);
  executeSqliteQuerySync(
    db,
    queries.insertInto("agent_databases").values([
      { agent_id: "main", path: relative, schema_version: 18, last_seen_at: 100, size_bytes: 10 },
      { agent_id: "main", path: namespaced, schema_version: 20, last_seen_at: 200, size_bytes: 20 },
      { agent_id: "main", path: external, schema_version: 20, last_seen_at: 300, size_bytes: 30 },
    ]),
  );
  const readRows = () =>
    executeSqliteQuerySync(db, queries.selectFrom("agent_databases").selectAll().orderBy("path"))
      .rows;
  const versions = () => [
    { path: database.path, userVersion: OPENCLAW_STATE_SCHEMA_VERSION },
    ...readRows().map((row) => ({
      path: resolveOpenClawRegisteredAgentDatabasePath(database.path, row.path),
      userVersion: row.schema_version,
    })),
  ];
  const startUpdate = () =>
    executeSqliteQuerySync(
      db,
      queries.insertInto("update_runs").values({
        run_id: "00000000-0000-4000-8000-000000000001",
        created_at_ms: 1,
        updated_at_ms: 1,
        trigger: "cli",
        phase: "validating",
        status: "running",
        origin_json: "{}",
        target_json: "{}",
        before_json: "{}",
        after_json: "{}",
        steps_json: "[]",
        verification_json: "{}",
        repair_json: "[]",
      }),
    );
  return { database, queries, namespaced, external, readRows, versions, startUpdate };
}

function context(env: NodeJS.ProcessEnv = {}, shouldRepair = true): DoctorHealthFlowContext {
  return {
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    options: { repair: shouldRepair },
    prompter: {
      confirm: async () => shouldRepair,
      confirmAutoFix: async () => shouldRepair,
      confirmAggressiveAutoFix: async () => shouldRepair,
      confirmRuntimeRepair: async () => shouldRepair,
      select: async (_params, fallback) => fallback,
      shouldRepair,
      shouldForce: false,
      repairMode: {
        shouldRepair,
        shouldForce: false,
        nonInteractive: true,
        canPrompt: false,
        updateInProgress: false,
      },
    },
    configResult: { cfg: {} },
    cfg: {},
    cfgForPersistence: {},
    sourceConfigValid: true,
    configPath: String.raw`C:\synthetic\state\openclaw.json`,
    env,
  };
}

describe("Doctor Windows database path repair", () => {
  beforeEach(() => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    fixture.beforeAdmission = undefined;
    fixture.note.mockClear();
  });
  afterEach(() => {
    fixture.database?.db.close();
    fixture.database = undefined;
    vi.unstubAllGlobals();
  });

  it.each([String.raw`C:\synthetic\state`, String.raw`\\server\share\state`])(
    "consolidates namespace aliases at %s before the next update baseline",
    async (stateDir) => {
      const state = seedDatabase(stateDir);
      await runStateIntegrityHealth(context());
      expect(state.readRows()).toHaveLength(2);
      expect(state.readRows()).toContainEqual({
        agent_id: "main",
        path: relative,
        schema_version: 20,
        last_seen_at: 200,
        size_bytes: 20,
      });
      expect(state.readRows()).toContainEqual({
        agent_id: "main",
        path: state.external,
        schema_version: 20,
        last_seen_at: 300,
        size_bytes: 30,
      });
      const baseline = state.versions();
      state.startUpdate();
      await runStateIntegrityHealth(context());
      expect(
        updateStateSchemaVersionsMatch(baseline, state.versions(), {
          sharedPath: state.database.path,
        }),
      ).toBe(true);
      expect(
        updateStateSchemaVersionsMatch(baseline, state.versions(), {
          sharedPath: state.database.path,
          candidateSchemaVersions: { state: OPENCLAW_STATE_SCHEMA_VERSION, agent: 20 },
        }),
      ).toBe(true);
    },
  );

  it("keeps newer canonical facts when the namespace alias is older", async () => {
    const state = seedDatabase();
    executeSqliteQuerySync(
      state.database.db,
      state.queries
        .updateTable("agent_databases")
        .set({ last_seen_at: 500, size_bytes: null })
        .where("path", "=", relative),
    );
    await runStateIntegrityHealth(context());
    expect(state.readRows().find((row) => row.path === relative)).toEqual({
      agent_id: "main",
      path: relative,
      schema_version: 18,
      last_seen_at: 500,
      size_bytes: null,
    });
    expect(state.readRows()).toHaveLength(2);
  });

  it("preserves distinct internal databases for one agent and does nothing on a standalone rerun", async () => {
    const state = seedDatabase();
    const retained = {
      agent_id: "main",
      path: String.raw`agents\main\archive\openclaw-agent.sqlite`,
      schema_version: 18,
      last_seen_at: 400,
      size_bytes: 40,
    };
    executeSqliteQuerySync(
      state.database.db,
      state.queries.insertInto("agent_databases").values(retained),
    );
    await runStateIntegrityHealth(context());
    const repaired = state.readRows();
    expect(repaired).toHaveLength(3);
    expect(repaired).toContainEqual(retained);
    fixture.note.mockClear();

    await runStateIntegrityHealth(context());
    expect(state.readRows()).toEqual(repaired);
    expect(fixture.note).not.toHaveBeenCalled();
  });

  it("rechecks the update ledger after admission and records a warning without changing the baseline", async () => {
    const state = seedDatabase();
    const baseline = state.versions();
    fixture.beforeAdmission = state.startUpdate;
    const ctx = context();
    await runStateIntegrityHealth(ctx);
    expect(state.readRows()).toHaveLength(3);
    expect(ctx.updateWarnings).toEqual([
      "Skipped agent database path repair while update 00000000-0000-4000-8000-000000000001 is in progress. Run openclaw doctor --fix after the update finishes.",
    ]);
    expect(fixture.note).toHaveBeenCalledWith(ctx.updateWarnings?.[0], "Doctor warnings");
    expect(
      updateStateSchemaVersionsMatch(baseline, state.versions(), {
        sharedPath: state.database.path,
      }),
    ).toBe(true);
  });

  it.each([
    { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
    { OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1" },
    { OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" },
  ])("leaves candidate and update Doctor inventory unchanged for %j", async (env) => {
    const state = seedDatabase();
    const before = state.readRows();
    const ctx = context(env);
    await runStateIntegrityHealth(ctx);
    expect(state.readRows()).toEqual(before);
    expect(ctx.updateWarnings).toEqual([
      "Skipped agent database path repair during update Doctor. Run openclaw doctor --fix after the update finishes.",
    ]);
  });

  it("leaves ordinary Doctor inspection read-only", async () => {
    const state = seedDatabase();
    const before = state.readRows();
    await runStateIntegrityHealth(context({}, false));
    expect(state.readRows()).toEqual(before);
    expect(fixture.note).not.toHaveBeenCalled();
  });

  it("refuses unrecognized shared-state ownership before removing aliases", async () => {
    const state = seedDatabase();
    state.database.db.exec("UPDATE schema_meta SET role = 'agent'");
    const before = state.readRows();
    await expect(runStateIntegrityHealth(context())).rejects.toThrow("schema role agent");
    expect(state.readRows()).toEqual(before);
  });
});
