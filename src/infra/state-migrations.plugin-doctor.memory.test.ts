import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
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
  const root = await tempDirs.make("doctor-memory-sidecar-hold-");
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
  const originals = [state.legacyPath, state.agentPath, state.memoryPath].map(
    (file) => [file, fs.readFileSync(file)] as const,
  );
  const retiredWorkspace = path.join(state.stateDir, "agents", "main", "qmd");
  fs.mkdirSync(retiredWorkspace);
  registry.entries.push({
    pluginId: "memory-core",
    channelIds: [],
    migration: state.independentMigration,
  });

  const result = await runPluginDoctorStateMigrationPlans(state);

  expect(result.warningDisposition).toBe("recoverable");
  expect(result.warnings).toEqual([
    expect.stringContaining("held after deletion journal reconstruction"),
  ]);
  expect(result.changes).toContain(
    `Removed empty retired Memory Core QMD workspace: ${retiredWorkspace}`,
  );
  expect(fs.existsSync(retiredWorkspace)).toBe(false);
  for (const [file, bytes] of originals) {
    expect(fs.readFileSync(file)).toEqual(bytes);
  }
  expect(fs.existsSync(`${state.legacyPath}.migrated`)).toBe(false);
});
