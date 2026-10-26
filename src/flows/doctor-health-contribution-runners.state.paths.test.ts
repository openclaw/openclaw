import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { createSqliteWalReclamationResult } from "../infra/sqlite-wal-reclamation.js";
import {
  OPENCLAW_STATE_SCHEMA_VERSION,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db-contract.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import {
  createDoctorHealthFlowContext,
  createDoctorPrompterFixture,
} from "./doctor-health-context.test-support.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import { initialDoctorHealthContribution } from "./doctor-health-contributions-selection.test-support.js";

vi.hoisted(() => {
  // Shared-worker setup can import path helpers before this Windows simulation.
  // Re-evaluate that graph so it consumes this file’s node:path mock.
  vi.resetModules();
});

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
const databaseRow = (
  pathname: string,
  schema_version = 20,
  last_seen_at = 200,
  size_bytes: number | null = 20,
) => ({ agent_id: "main", path: pathname, schema_version, last_seen_at, size_bytes });

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
    walMaintenance: {
      stop: async () => {},
      checkpoint: () => true,
      close: () => true,
      reclaimFreePages: createSqliteWalReclamationResult,
    },
  };
  fixture.database = database;
  const queries = getNodeSqliteKysely<Pick<DB, "agent_databases" | "update_runs">>(db);
  const insert = (rows: ReturnType<typeof databaseRow>[]) =>
    executeSqliteQuerySync(db, queries.insertInto("agent_databases").values(rows));
  const update = (pathname: string, values: Partial<ReturnType<typeof databaseRow>>) =>
    executeSqliteQuerySync(
      db,
      queries.updateTable("agent_databases").set(values).where("path", "=", pathname),
    );
  const namespaced = path.toNamespacedPath(path.join(stateDir, relative));
  const external = path.toNamespacedPath(String.raw`D:\other\openclaw-agent.sqlite`);
  insert([
    databaseRow(relative, 18, 100, 10),
    databaseRow(namespaced),
    databaseRow(external, 20, 300, 30),
  ]);
  const readRows = () =>
    executeSqliteQuerySync(db, queries.selectFrom("agent_databases").selectAll().orderBy("path"))
      .rows;
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
  return { database, insert, update, external, readRows, startUpdate };
}

function context(env: NodeJS.ProcessEnv = {}, shouldRepair = true): DoctorHealthFlowContext {
  return createDoctorHealthFlowContext({
    options: { repair: shouldRepair },
    prompter: createDoctorPrompterFixture(shouldRepair),
    configResult: { confirmedConfigSource: undefined },
    configPath: String.raw`C:\synthetic\state\openclaw.json`,
    env,
  });
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

  it.each([
    [String.raw`\\server\share\state`, false],
    [String.raw`C:\synthetic\state`, true],
  ] as const)(
    "consolidates namespace aliases at %s and preserves newer facts",
    async (stateDir, canonicalNewer) => {
      const state = seedDatabase(stateDir);
      if (canonicalNewer) {
        state.update(relative, { last_seen_at: 500, size_bytes: null });
      }
      const retained = databaseRow(
        String.raw`agents\main\archive\openclaw-agent.sqlite`,
        18,
        400,
        40,
      );
      state.insert([retained]);
      await initialDoctorHealthContribution("doctor:state-integrity").run(context());
      const repaired = state.readRows();
      expect(repaired).toHaveLength(3);
      expect(repaired).toEqual(
        expect.arrayContaining([
          canonicalNewer ? databaseRow(relative, 18, 500, null) : databaseRow(relative),
          databaseRow(state.external, 20, 300, 30),
          retained,
        ]),
      );
      fixture.note.mockClear();
      await initialDoctorHealthContribution("doctor:state-integrity").run(context());
      expect(state.readRows()).toEqual(repaired);
      expect(fixture.note).not.toHaveBeenCalled();
    },
  );

  it("rechecks the update ledger after admission and records a warning without changing the baseline", async () => {
    const state = seedDatabase();
    const baseline = state.readRows();
    fixture.beforeAdmission = state.startUpdate;
    const ctx = context();
    await initialDoctorHealthContribution("doctor:state-integrity").run(ctx);
    expect(ctx.updateWarnings).toEqual([
      "Skipped agent database path repair while update 00000000-0000-4000-8000-000000000001 is in progress. Run openclaw doctor --fix after the update finishes.",
    ]);
    expect(fixture.note).toHaveBeenCalledWith(ctx.updateWarnings?.[0], "Doctor warnings");
    expect(state.readRows()).toEqual(baseline);
  });

  it.each([true, false])(
    "leaves inventory unchanged with update Doctor = %s",
    async (updateDoctor) => {
      const state = seedDatabase();
      const before = state.readRows();
      const ctx = context(updateDoctor ? { OPENCLAW_UPDATE_IN_PROGRESS: "1" } : {}, updateDoctor);
      await initialDoctorHealthContribution("doctor:state-integrity").run(ctx);
      expect(state.readRows()).toEqual(before);
      if (updateDoctor) {
        expect(ctx.updateWarnings).toEqual([
          "Skipped agent database path repair during update Doctor. Run openclaw doctor --fix to repair agent database paths.",
        ]);
      } else {
        expect(fixture.note).not.toHaveBeenCalled();
      }
    },
  );

  it("refuses unrecognized shared-state ownership before removing aliases", async () => {
    const state = seedDatabase();
    state.database.db.exec("UPDATE schema_meta SET role = 'agent'");
    const before = state.readRows();
    await expect(
      initialDoctorHealthContribution("doctor:state-integrity").run(context()),
    ).rejects.toThrow("schema role agent");
    expect(state.readRows()).toEqual(before);
  });
});
