import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { assertDatabasePortPluginMigrationsComplete } from "../commands/doctor-database-port-migrations.js";
import type {
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationEntry,
} from "../plugins/doctor-contract-module.js";
import { recordAgentDeletionRecoveryHolds } from "../state/agent-deletion-journal-recovery.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import * as nodeSqlite from "./node-sqlite.js";
import { runPluginDoctorStateMigrationPlans } from "./state-migrations.plugin-doctor.js";

const registry = vi.hoisted(() => ({
  entries: [] as PluginDoctorStateMigrationEntry[],
}));

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>()),
  listPluginDoctorStateMigrationEntries: () => registry.entries,
}));

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  vi.restoreAllMocks();
  registry.entries = [];
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

async function fixture() {
  const root = await tempDirs.make("doctor-postgres-memory-sidecar-");
  const stateDir = path.join(root, "state");
  const legacyPath = path.join(stateDir, "memory", "main.sqlite");
  const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  const memoryPath = path.join(root, "workspace", "MEMORY.md");
  for (const file of [legacyPath, agentPath, memoryPath]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(memoryPath, "Remember the violet observatory.\n");
  {
    using db = new DatabaseSync(legacyPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE files (path TEXT PRIMARY KEY, source TEXT NOT NULL, hash TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE chunks (id TEXT PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, hash TEXT NOT NULL, model TEXT NOT NULL, text TEXT NOT NULL, embedding TEXT NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO meta VALUES ('memory_index_meta_v1', '{"vectorDims":3}');
      INSERT INTO files VALUES ('MEMORY.md', 'memory', 'source-hash', 1, 32);
      INSERT INTO chunks VALUES ('chunk-1', 'MEMORY.md', 'memory', 1, 1, 'chunk-hash', 'fixture', 'Remember the violet observatory.', '[1,0,0]', 1);
    `);
  }
  const contract = new URL("../../extensions/memory-core/doctor-contract-api.ts", import.meta.url);
  const { stateMigrations } = (await import(/* @vite-ignore */ contract.href)) as {
    stateMigrations: PluginDoctorStateMigration[];
  };
  const migration = stateMigrations.find(
    (entry) => entry.id === "memory-core-legacy-sidecar-index-to-agent-sqlite",
  );
  const independentMigration = stateMigrations.find(
    (entry) => entry.id === "memory-core-qmd-workspace-retired",
  );
  if (!migration || !independentMigration) {
    throw new Error("Missing Memory Core doctor migrations");
  }
  registry.entries = [{ pluginId: "memory-core", channelIds: [], migration }];
  return {
    stateDir,
    legacyPath,
    agentPath,
    memoryPath,
    env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_HOME: root },
    config: { agents: { entries: { main: { workspace: path.dirname(memoryPath) } } } },
    detected: { stateDir, oauthDir: path.join(stateDir, "oauth"), doctorOnlyStateMigrations: true },
    independentMigration,
    preserveFiles() {
      const files = [legacyPath, agentPath, memoryPath];
      const originals = files.map((file) => fs.readFileSync(file));
      return () => expect(files.map((file) => fs.readFileSync(file))).toEqual(originals);
    },
  };
}

it("keeps held memory sidecars advisory while completing independent repairs", async () => {
  const state = await fixture();
  openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  runOpenClawStateWriteTransaction(
    (database) =>
      recordAgentDeletionRecoveryHolds(database, [{ agentId: "main", path: state.agentPath }]),
    { env: state.env },
  );
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  const expectPreserved = state.preserveFiles();
  const retiredWorkspace = path.join(state.stateDir, "agents", "main", "qmd");
  fs.mkdirSync(retiredWorkspace);
  registry.entries.push({
    pluginId: "memory-core",
    channelIds: [],
    migration: state.independentMigration,
  });

  const result = await runPluginDoctorStateMigrationPlans(state);

  expect(result).toMatchObject({
    warningDisposition: "recoverable",
    warnings: [expect.stringContaining("held after deletion journal reconstruction")],
    changes: expect.arrayContaining([
      `Removed empty retired Memory Core QMD workspace: ${retiredWorkspace}`,
    ]),
  });
  expect(fs.existsSync(retiredWorkspace)).toBe(false);
  expectPreserved();
  expect(fs.existsSync(`${state.legacyPath}.migrated`)).toBe(false);
});

it("retains a legacy memory sidecar without opening the PostgreSQL agent anchor", async () => {
  const state = await fixture();
  const { legacyPath, agentPath } = state;
  {
    using anchor = new DatabaseSync(agentPath);
    anchor.exec(`
      CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL CHECK (engine = 'postgres'), schema TEXT NOT NULL);
      INSERT INTO openclaw_engine_anchor VALUES ('fixture-agent', 'postgres', 'fixture_agent');
    `);
  }
  const expectPreserved = state.preserveFiles();
  const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation(() => {
    throw new Error("The skipped migration must not open SQLite");
  });
  const result = await runPluginDoctorStateMigrationPlans({
    ...state,
    config: { ...state.config, database: { engine: "postgres" } },
  });
  expect(result).toMatchObject({
    changes: [],
    warnings: [],
    notices: [
      expect.stringContaining(
        "legacy SQLite migration not applicable on PostgreSQL; legacy data is migrated before port",
      ),
    ],
  });
  expect(result.notices?.[0]).toContain("sidecar is retained unchanged");
  expect(result.notices?.[0]).toContain("may re-embed");
  expect(open).not.toHaveBeenCalled();
  expectPreserved();
  expect(fs.readdirSync(path.dirname(legacyPath))).toEqual(["main.sqlite"]);
});

it("requires the real memory sidecar repair before porting the agent family", async () => {
  const state = await fixture();
  const preflight = () =>
    assertDatabasePortPluginMigrationsComplete({
      config: state.config,
      env: state.env,
      stateDir: state.stateDir,
      to: "postgres",
    });
  const source = fs.readFileSync(state.legacyPath);
  await expect(preflight()).rejects.toThrow("memory-core-legacy-sidecar-index-to-agent-sqlite");
  expect(fs.readFileSync(state.legacyPath)).toEqual(source);
  const repaired = await runPluginDoctorStateMigrationPlans(state);
  expect(repaired.warnings).toEqual([]);
  expect(repaired.changes).toContainEqual(
    expect.stringContaining("Migrated Memory Core legacy memory index"),
  );
  expect(fs.existsSync(state.legacyPath)).toBe(false);
  expect(fs.readFileSync(`${state.legacyPath}.migrated`)).toEqual(source);
  await expect(preflight()).resolves.toBeUndefined();
});
