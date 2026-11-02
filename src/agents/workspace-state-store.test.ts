import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, onTestFinished } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  readWorkspaceFileCache,
  retireWorkspaceFileCache,
  writeWorkspaceFileCache,
} from "./workspace-file-cache.js";
import {
  createWorkspaceStateIdentity,
  resolveWorkspaceStateIdentity,
} from "./workspace-state-identity.js";
import { workspaceStatePublication } from "./workspace-state-publication.js";
import {
  clearExpiredWorkspaceStateForVanishedWorkspace,
  deleteWorkspaceState,
  mergeWorkspaceSetupState,
  prepareWorkspaceStateDeletion,
  readWorkspaceStateSnapshot as read,
  replaceWorkspaceAttestation,
  WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
} from "./workspace-state-store.js";
import { registerWorkspaceStateAliasIdentitiesInTransaction } from "./workspace-state-store.kernel.js";

let testState: OpenClawTestState;
let dir: string;
const seededAt = "2026-07-16T01:00:00.000Z";

beforeEach(async () => {
  testState = await createOpenClawTestState({ layout: "state-only", prefix: "workspace-store-" });
  dir = testState.workspaceDir;
});

afterEach(async () => {
  retireWorkspaceFileCache(dir);
  closeOpenClawStateDatabaseForTest();
  await testState.cleanup();
});

function seed() {
  return mergeWorkspaceSetupState(dir, { bootstrapSeededAt: seededAt }, 1_000);
}

function sql(statement: string) {
  return openOpenClawStateDatabase().db.prepare(statement);
}

function observeFacts() {
  const observed = new Map<string, unknown>();
  const unsubscribe = workspaceStatePublication.subscribeFacts((change) => {
    if (change.kind === "committed") {
      change.receipt.facts.forEach((fact, key) => observed.set(key, fact));
    }
  });
  onTestFinished(unsubscribe);
  return observed;
}

function attest(nowMs: number, hashes: [string, string][]) {
  return replaceWorkspaceAttestation({
    workspaceDir: dir,
    attestedAtMs: nowMs,
    nowMs,
    generatedHashes: new Map(hashes),
  });
}

async function deleteState(targetDir: string): Promise<void> {
  await deleteWorkspaceState(prepareWorkspaceStateDeletion(targetDir));
}

function insertPersistedAttestationHash(filename: string, sha256: string): void {
  const identity = resolveWorkspaceStateIdentity(dir);
  sql(
    "INSERT INTO workspace_setup_state (workspace_key, workspace_path, attested_at_ms, attestation_updated_at_ms) VALUES (?, ?, 1, 1)",
  ).run(identity.workspaceKey, identity.workspacePath);
  sql(
    "INSERT INTO workspace_generated_bootstrap_hashes (workspace_key, filename, sha256) VALUES (?, ?, ?)",
  ).run(identity.workspaceKey, filename, sha256);
}

it("registers alias batches once and rolls back conflicts without publishing partial aliases", () => {
  const identity = resolveWorkspaceStateIdentity(dir);
  const aliases = Array.from({ length: 70 }, (_, index) =>
    createWorkspaceStateIdentity(testState.path(`alias-${index}`)),
  );
  const observed = observeFacts();
  const register = (entries: typeof aliases, updatedAtMs: number, target = identity) =>
    runOpenClawStateWriteTransaction((database) =>
      registerWorkspaceStateAliasIdentitiesInTransaction({
        database,
        identity: target,
        aliases: entries,
        updatedAtMs,
      }),
    );
  register([...aliases, aliases[0]!], 1000);
  register(aliases, 2000);
  expect(sql("SELECT COUNT(*) AS count FROM workspace_path_aliases").get()).toEqual({
    count: 70,
  });
  for (const alias of aliases) {
    expect(
      sql("SELECT updated_at_ms FROM workspace_path_aliases WHERE alias_key = ?").get(
        alias.workspaceKey,
      ),
    ).toEqual({
      updated_at_ms: 1000,
    });
  }
  const missing = Array.from({ length: 65 }, (_, index) =>
    createWorkspaceStateIdentity(testState.path(`rollback-${index}`)),
  );
  observed.clear();
  expect(() =>
    register(
      [...missing, aliases[0]!],
      3000,
      createWorkspaceStateIdentity(testState.path("other")),
    ),
  ).toThrow("workspace path alias conflicts with canonical state");
  expect(observed.size).toBe(0);
  expect(sql("SELECT COUNT(*) AS count FROM workspace_path_aliases").get()).toEqual({
    count: 70,
  });
});

it("replaces complete hash sets and removes aliased setup and attestation state", async () => {
  await seed();
  const alias = testState.path("receipt-workspace-link");
  fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
  await read(alias);
  await attest(1000, [
    ["AGENTS.md", "a".repeat(64)],
    ["TOOLS.md", "b".repeat(64)],
  ]);
  await attest(2000, [["AGENTS.md", "c".repeat(64)]]);
  expect((await read(dir)).attestation).toEqual({
    attestedAtMs: 2000,
    generatedHashes: new Map([["AGENTS.md", "c".repeat(64)]]),
  });
  expect(sql("SELECT COUNT(*) AS count FROM workspace_path_aliases").get()).toEqual({ count: 2 });
  await deleteState(alias);
  expect(sql("SELECT COUNT(*) AS count FROM workspace_path_aliases").get()).toEqual({ count: 0 });
  const { setupExists, attestation } = await read(dir, { readOnly: true });
  expect([setupExists, attestation]).toEqual([false, undefined]);
});

it("does not create shared state for a read-only snapshot", async () => {
  const statePath = resolveOpenClawStateSqlitePath(testState.env);
  expect(fs.existsSync(statePath)).toBe(false);

  const snapshot = await read(dir, { env: testState.env, readOnly: true });
  expect(snapshot).toMatchObject({ setupExists: false, setup: { version: 1 } });
  expect(fs.existsSync(statePath)).toBe(false);
});

it.each([
  ["NUL.md", "a".repeat(64)],
  [".hidden.md", "a".repeat(64)],
  ["AGENTS.md", "a".repeat(63)],
])("rejects an invalid persisted attestation: %s", async (filename, hash) => {
  insertPersistedAttestationHash(filename, hash);
  await expect(read(dir)).rejects.toThrow("workspace attestation hash row is invalid");
});

it("refuses retired ownership before deleting state", async () => {
  await seed();
  await attest(1_000, [["AGENTS.md", "a".repeat(64)]]);
  const before = await read(dir);
  const filePath = path.join(dir, "AGENTS.md");
  writeWorkspaceFileCache({ filePath, content: "cached", identity: "identity" });
  const retired = new Error("workspace owner retired");
  const assertCurrent = () => {
    throw retired;
  };
  await expect(
    deleteWorkspaceState(prepareWorkspaceStateDeletion(dir), { assertCurrent }),
  ).rejects.toBe(retired);
  expect(await read(dir)).toEqual(before);
  expect(readWorkspaceFileCache(filePath, "identity")).toBe("cached");
});

it("registers and retires aliases in the captured caller-selected state database", async () => {
  const alias = testState.path("workspace-link");
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: testState.path("custom-state"),
  };
  fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
  const identity = resolveWorkspaceStateIdentity(dir);
  await mergeWorkspaceSetupState(dir, { bootstrapSeededAt: seededAt }, 1_000, {
    env,
  });

  expect((await read(alias, { env })).identity).toStrictEqual(identity);
  fs.unlinkSync(alias);

  expect((await read(alias, { env })).identity).toStrictEqual(identity);
  expect((await read(alias, { env })).setupExists).toBe(true);
  expect(resolveOpenClawStateSqlitePath(env)).not.toBe(resolveOpenClawStateSqlitePath());
  expect((await read(alias)).setupExists).toBe(false);

  const selectedPath = resolveOpenClawStateSqlitePath(env);
  const deletion = deleteWorkspaceState(prepareWorkspaceStateDeletion(alias), { env });
  env.OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR!;
  await deletion;
  expect((await read(dir, { path: selectedPath })).setupExists).toBe(false);
});

it("cleans current state and only the stale association for a repointed alias", async () => {
  const alias = testState.path("workspace-link");
  const replacement = testState.path("replacement-workspace");
  fs.mkdirSync(replacement, { recursive: true });
  fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
  await mergeWorkspaceSetupState(alias, { bootstrapSeededAt: seededAt }, 1_000);
  await mergeWorkspaceSetupState(
    replacement,
    { bootstrapSeededAt: "2026-07-16T02:00:00.000Z" },
    2_000,
  );
  fs.unlinkSync(alias);
  fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");

  const deletion = prepareWorkspaceStateDeletion(alias);
  fs.unlinkSync(alias);
  await deleteWorkspaceState(deletion);

  expect((await read(dir)).setupExists).toBe(true);
  expect((await read(replacement)).setupExists).toBe(false);
  const staleAlias = sql("SELECT alias_key FROM workspace_path_aliases WHERE alias_path = ?").get(
    alias,
  );
  expect(staleAlias).toBeUndefined();
});

it.each(["delete", "expire"])("keeps %s cache entries when the commit fails", async (cleanup) => {
  await seed();
  const filePath = path.join(dir, "AGENTS.md");
  writeWorkspaceFileCache({ filePath, content: "cached", identity: "identity" });
  const db = openOpenClawStateDatabase().db;
  db.exec(`CREATE TABLE workspace_commit_guard (
        workspace_key TEXT REFERENCES workspace_setup_state(workspace_key)
          DEFERRABLE INITIALLY DEFERRED
      )`);
  sql("INSERT INTO workspace_commit_guard VALUES (?)").run(
    resolveWorkspaceStateIdentity(dir).workspaceKey,
  );
  const remove = async () =>
    cleanup === "delete"
      ? await deleteState(dir)
      : await clearExpiredWorkspaceStateForVanishedWorkspace(dir, 86_401_001);

  await expect(remove()).rejects.toThrow(/FOREIGN KEY constraint failed/u);
  expect((await read(dir)).setupExists).toBe(true);
  expect(readWorkspaceFileCache(filePath, "identity")).toBe("cached");

  db.exec("DELETE FROM workspace_commit_guard");
  await remove();
  expect((await read(dir)).setupExists).toBe(false);
  expect(readWorkspaceFileCache(filePath, "identity")).toBeUndefined();
});

it("does not recreate a missing database during delete-only cleanup", async () => {
  const filePath = path.join(dir, "AGENTS.md");
  writeWorkspaceFileCache({ filePath, content: "cached", identity: "identity" });
  const databasePath = resolveOpenClawStateSqlitePath();
  closeOpenClawStateDatabaseForTest();
  fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });

  await deleteState(dir);

  expect(fs.existsSync(databasePath)).toBe(false);
  expect(fs.existsSync(path.dirname(databasePath))).toBe(false);
  expect(readWorkspaceFileCache(filePath, "identity")).toBeUndefined();
});

it("deletes migration receipts owned by the workspace", async () => {
  const identity = resolveWorkspaceStateIdentity(dir);
  await mergeWorkspaceSetupState(dir, { bootstrapSeededAt: seededAt });
  const insertReceipt = sql(
    "INSERT INTO migration_sources (source_key, migration_kind, source_path, target_table, last_run_id, status, imported_at, report_json) VALUES (?, ?, ?, 'workspace_setup_state', ?, 'completed', 1, ?)",
  );
  const receipt = (
    id: string,
    run: string,
    source = path.join(dir, ".openclaw", "workspace-state.json"),
    report = JSON.stringify({ workspaceKey: identity.workspaceKey }),
    kind = WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
  ) => {
    sql(
      "INSERT OR IGNORE INTO migration_runs (id, started_at, finished_at, status, report_json) VALUES (?, 1, 1, 'completed', '{}')",
    ).run(run);
    insertReceipt.run(id, kind, source, run, report);
  };
  receipt("owned-receipt", "owned-run");
  receipt("owned-shared-receipt", "shared-run");
  receipt("retained-receipt", "shared-run", "/other/source", "{}", "unrelated-migration-kind");
  receipt(
    "unrelated-receipt",
    "unrelated-run",
    "/other/workspace-state.json",
    JSON.stringify({ workspaceKey: "other-workspace" }),
  );

  await deleteState(dir);

  const receipts = sql("SELECT source_key FROM migration_sources ORDER BY source_key").all();
  expect(receipts).toEqual([
    { source_key: "retained-receipt" },
    { source_key: "unrelated-receipt" },
  ]);
  const runs = sql("SELECT id FROM migration_runs ORDER BY id").all();
  expect(runs).toEqual([{ id: "shared-run" }, { id: "unrelated-run" }]);
});
