import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  withStateMigrationBackupForTest,
} from "../../state/openclaw-state-schema.test-support.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { insertRegistryWorktreeProvisionedChunk } from "./provisioned-snapshot.test-support.js";
import {
  getRegistryWorktreeProvisionedChunk,
  prepareWorktreeRegistryGuard,
} from "./registry-read.js";
import {
  abortWorktreeRemovalRow,
  claimWorktreeRemovalRow,
  clearRegistryWorktreeProvisionedChunks,
  createWorktreeRemovalClaimsGuard,
  deleteRegistryWorktree,
  getRegistryWorktreeProvisionedPaths,
  getRegistryWorktreeProvisionedState,
  insertRegistryWorktree,
  listLegacyRegistryWorktreesForMigration,
  listRegistryWorktreesForMigration,
  updateRegistryWorktree,
} from "./registry.js";
import {
  findLiveRegistryWorktreeByOwner,
  findLiveRegistryWorktreeByPath,
  getRegistryWorktree,
  listRegistryWorktrees,
} from "./registry.test-support.js";
import type { ManagedWorktreeRecord } from "./types.js";

let root: string;
let env: NodeJS.ProcessEnv;
let record: ManagedWorktreeRecord;
let chunk: { worktreeId: string; path: string; chunkIndex: number };
const bytes = Buffer.from("synthetic snapshot bytes");
const readChunk = () => getRegistryWorktreeProvisionedChunk(env, chunk);
const writeChunk = () => insertRegistryWorktreeProvisionedChunk(env, { ...chunk, data: bytes });
async function closeDatabase() {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "worktree-registry-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "ambient"));
  env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  record = {
    id: "isolated",
    name: "isolated",
    repoFingerprint: "0123456789abcdef",
    repoRoot: path.join(root, "repo"),
    path: path.join(root, "isolated"),
    branch: "openclaw/isolated",
    baseRef: "HEAD",
    ownerKind: "manual",
    createdAt: 10,
    lastActiveAt: 10,
  };
  chunk = { worktreeId: record.id, path: "sample.txt", chunkIndex: 0 };
});

afterEach(async () => {
  await closeDatabase();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

it("checks every captured removal claim in the current database generation", async () => {
  const token = "synthetic-shared-removal-token";
  for (const id of ["first", "second", "unrelated"]) {
    await insertRegistryWorktree(env, { ...record, id });
    await claimWorktreeRemovalRow(env, {
      worktreeId: id,
      token,
      pid: process.pid,
      startTime: null,
      now: 1,
    });
  }
  const assertClaims = createWorktreeRemovalClaimsGuard(env, ["first", "second", "first"], token);
  expect(assertClaims).not.toThrow();
  await closeDatabase();
  expect(assertClaims).not.toThrow();
  await abortWorktreeRemovalRow(env, "second", token);
  expect(assertClaims).toThrow("Worktree removal claim changed");
});

it("keeps explicit-state writes independent of a read-only ambient database", async () => {
  const ambient = openOpenClawStateDatabase();
  ambient.db.exec("PRAGMA query_only = ON");
  try {
    await insertRegistryWorktree(env, record, { provisionedPaths: [chunk.path] });
    await writeChunk();
    expect(Buffer.from((await readChunk())!)).toEqual(bytes);
    await clearRegistryWorktreeProvisionedChunks(env, record.id);
    expect(await readChunk()).toBeUndefined();
    await writeChunk();
    await updateRegistryWorktree(env, record.id, { lastActiveAt: 20 });
    expect(getRegistryWorktree(env, record.id)?.lastActiveAt).toBe(20);
    await deleteRegistryWorktree(env, record.id);
    expect(getRegistryWorktree(env, record.id)).toBeUndefined();
    expect(await readChunk()).toBeUndefined();
    expect(listRegistryWorktrees(process.env)).toEqual([]);
  } finally {
    ambient.db.exec("PRAGMA query_only = OFF");
  }
});

it("rolls back explicit-state snapshot deletion when deleting its worktree fails", async () => {
  await insertRegistryWorktree(env, record, { provisionedPaths: [chunk.path] });
  await writeChunk();
  const { db } = openOpenClawStateDatabase({ env });
  db.exec(`
      CREATE TRIGGER registry_delete_fault BEFORE DELETE ON worktrees
      WHEN OLD.id = 'isolated'
      BEGIN SELECT RAISE(ABORT, 'synthetic deletion failure'); END;
    `);

  await expect(deleteRegistryWorktree(env, record.id)).rejects.toThrow(
    "synthetic deletion failure",
  );
  expect(getRegistryWorktree(env, record.id)).toEqual(record);
  expect(Buffer.from((await readChunk()) ?? [])).toEqual(bytes);
});

it("inspects absent legacy worktrees without creating the state database", async () => {
  expect(listLegacyRegistryWorktreesForMigration(env)).toEqual([]);
  expect(listRegistryWorktreesForMigration(env)).toEqual([]);
  await expect(fs.stat(env.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps retirement preparation read-only and reaps dead consumers when deleting the snapshot", async () => {
  record = { ...record, removedAt: 20 };
  await insertRegistryWorktree(env, record, { provisionedPaths: [] });
  const { db } = openOpenClawStateDatabase({ env });
  const scope = `worktree-run:${record.id}`;
  db.prepare(`
      INSERT INTO state_leases (scope, lease_key, owner, payload_json, created_at, updated_at)
      VALUES (?, 'dead-consumer', 'dead-owner', ?, 1, 1)
    `).run(scope, JSON.stringify({ pid: 2_147_483_647, starttime: 4242 }));
  const assertRetirement = await prepareWorktreeRegistryGuard(
    captureOpenClawStateWorkerContext({ env }),
    { predicates: [{ kind: "snapshot-retirement", record }] },
  );
  assertRetirement();
  const consumers = () =>
    db.prepare("SELECT lease_key FROM state_leases WHERE scope = ?").all(scope);
  expect(consumers()).toEqual([{ lease_key: "dead-consumer" }]);
  await deleteRegistryWorktree(env, record.id, { expectedRetired: record });
  expect(getRegistryWorktree(env, record.id)).toBeUndefined();
  expect(consumers()).toEqual([]);
});

it("persists, orders, and updates worktree rows through Kysely", async () => {
  record = { ...record, id: "first", ownerKind: "workboard", ownerId: "card-1" };
  await insertRegistryWorktree(env, record, { provisionedPaths: [".env.local"] });
  await insertRegistryWorktree(env, {
    ...record,
    id: "second",
    path: path.join(root, "second", record.name),
    createdAt: 20,
    lastActiveAt: 20,
  });

  expect(listRegistryWorktrees(env).map((entry) => entry.id)).toEqual(["second", "first"]);
  expect(listRegistryWorktreesForMigration(env)).toEqual(listRegistryWorktrees(env));
  expect(listLegacyRegistryWorktreesForMigration(env).map((entry) => entry.id)).toEqual(["second"]);
  expect(await getRegistryWorktreeProvisionedPaths(env, "second")).toBeUndefined();

  const repositoryIdentity = {
    repoRoot: path.join(root, "rebound-repo"),
    repoFingerprint: "fedcba9876543210",
  };
  const provisionedState = [{ path: ".env.local", mode: 0o600, chunks: 1 }];
  const activity = { lastActiveAt: 30, removedAt: 40, snapshotRef: "refs/snapshots/first" };
  await updateRegistryWorktree(env, "first", { repositoryIdentity, ...activity, provisionedState });
  expect(getRegistryWorktree(env, "first")).toMatchObject({ ...repositoryIdentity, ...activity });
  expect(findLiveRegistryWorktreeByPath(env, record.path)).toBeUndefined();
  expect(await getRegistryWorktreeProvisionedPaths(env, "first")).toEqual([".env.local"]);
  expect(await getRegistryWorktreeProvisionedState(env, "first")).toEqual(provisionedState);
  openOpenClawStateDatabase({ env })
    .db.prepare("UPDATE worktrees SET provisioned_paths_json = ? WHERE id = ?")
    .run("not-json", "second");
  expect(await getRegistryWorktreeProvisionedPaths(env, "second")).toBeUndefined();
});

it("keeps record reads bounded when a worktree has a large provisioning manifest", async () => {
  record = {
    ...record,
    ownerKind: "session",
    ownerId: "session-1",
    snapshotRef: "refs/openclaw/snapshots/provisioned",
    runEndCleanup: { outcome: "retained-provisioned-drift", at: 30 },
  };
  const provisionedPaths = Array.from({ length: 1_000 }, (_, index) => `settings-${index}.json`);
  await insertRegistryWorktree(env, record, { provisionedPaths });
  const counter = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(openOpenClawStateDatabase({ env }).db),
    ["records"],
    (sql) => (/\bfrom\s+"worktrees"/iu.test(sql) ? "records" : null),
  );
  try {
    expect(listRegistryWorktrees(env)).toEqual([record]);
    expect(getRegistryWorktree(env, record.id)).toEqual(record);
    expect(findLiveRegistryWorktreeByPath(env, record.path)).toEqual(record);
    expect(findLiveRegistryWorktreeByOwner(env, "session", "session-1")).toEqual(record);
    expect(counter.textBytes.records).toBeLessThan(4_096);
  } finally {
    counter.restore();
  }
  expect(await getRegistryWorktreeProvisionedPaths(env, record.id)).toEqual(provisionedPaths);
});

it("reads the provisioned-path ledger after captured shared-state migration", async () => {
  const databasePath = openOpenClawStateDatabase({ env }).path;
  await closeDatabase();
  await fs.rename(databasePath, `${databasePath}.template`);
  await fs.copyFile(`${databasePath}.template`, databasePath, fs.constants.COPYFILE_EXCL);
  const { DatabaseSync } = requireNodeSqlite();
  const legacy = new DatabaseSync(databasePath);
  addPreCutoverClientCredentialTablesForTest(legacy);
  legacy.exec(`
      ALTER TABLE worktrees DROP COLUMN provisioned_paths_json;
      DROP INDEX idx_worker_session_placements_environment;
      PRAGMA user_version = 5;
      UPDATE schema_meta SET schema_version = 5 WHERE meta_key = 'primary';
    `);
  legacy.close();

  await withStateMigrationBackupForTest({ env }, () => openOpenClawStateDatabase({ env }));
  const database = openOpenClawStateDatabase({ env }).db;
  expect(await getRegistryWorktreeProvisionedPaths(env, "missing")).toBeUndefined();
  expect(database.prepare("PRAGMA table_info(worktrees)").all()).toContainEqual(
    expect.objectContaining({ name: "provisioned_paths_json" }),
  );
  const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  expect(table.get("worktree_provisioned_file_chunks")).toBeTruthy();
});
