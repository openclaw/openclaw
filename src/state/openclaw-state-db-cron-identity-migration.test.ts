import { copyFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  CRON_DEFAULT_STORE_IDENTITY_SCHEMA_VERSION,
  migrateCronDefaultStoreIdentity,
  readCronDefaultStoreKeyInDatabase,
  readCronStorePartitionInventoryInDatabase,
  resolveLegacyCronDefaultStoreKey,
  selectCronDefaultStoreIdentityInDatabase,
} from "./openclaw-state-db-cron-identity-migration.js";
import {
  closeOpenClawStateDatabaseForTest as closeState,
  openOpenClawStateDatabase as openState,
} from "./openclaw-state-db.js";
import { withStateMigrationBackupForTest } from "./openclaw-state-schema.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeState());

it("inventories a pre-fold-in database without machine state", () => {
  using db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE cron_jobs (store_key TEXT NOT NULL);
    INSERT INTO cron_jobs VALUES ('/legacy/cron/jobs.json');`);
  expect(readCronDefaultStoreKeyInDatabase(db)).toBeUndefined();
  expect(readCronStorePartitionInventoryInDatabase(db)).toEqual([
    {
      storeKey: "/legacy/cron/jobs.json",
      jobs: 1,
      scratch: 0,
      receipts: 0,
      history: 0,
      quarantine: 0,
      proactiveReceipts: 0,
    },
  ]);
});

function seedPartition(db: DatabaseSync, storeKey: string, jobs: boolean) {
  if (jobs) {
    db.prepare(`INSERT INTO cron_jobs
      (store_key, job_id, name, enabled, payload_kind, job_json, state_json, updated_at)
      VALUES (?, 'job', 'Migration job', 0, 'agentTurn', '{}', '{}', 1)`).run(storeKey);
  }
  db.prepare(`INSERT INTO cron_job_scratch
    (store_key, job_id, content, revision, updated_at_ms) VALUES (?, 'job', NULL, 7, 1)`).run(
    storeKey,
  );
  db.prepare(`INSERT INTO cron_run_receipts
    (cursor_id, receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
      status, owner_pid, started_at_ms, finished_at_ms)
    VALUES (1, 'cron-slot-v1.saved-identity', ?, 'job', 'revision', 'main', 'request-id',
      'skipped', 1, 1, 2)`).run(storeKey);
  db.prepare(`INSERT INTO task_runs
    (task_id, runtime, owner_key, scope_kind, task, status, delivery_status,
      notify_policy, created_at, detail_json)
    VALUES ('task', 'cron', 'main', 'system', '', 'succeeded', 'not_applicable',
      'silent', 1, ?)`).run(JSON.stringify({ storeKey, receiptId: "cron-slot-v1.saved-identity" }));
  db.prepare(`INSERT INTO diagnostic_events
    (scope, event_key, payload_json, created_at) VALUES (?, 'quarantine', '{}', 1)`).run(
    `cron.quarantine:${storeKey}`,
  );
  db.prepare(`INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
    VALUES (?, '{"jobId":"job","phase":"complete","provisionedAtMs":1}', 1)`).run(
    `automation-default:${storeKey}:main`,
  );
}

function legacyStore(
  jobs = true,
  previousVersion = CRON_DEFAULT_STORE_IDENTITY_SCHEMA_VERSION - 1,
) {
  const root = tempDirs.make("cron-identity-");
  const stateDir = path.join(root, "source");
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
  const database = openState(options);
  const databasePath = database.path;
  const storeKey = path.join(stateDir, "cron", "jobs.json");
  closeState();
  using legacy = new DatabaseSync(databasePath);
  legacy.exec(`DELETE FROM config_machine_state WHERE state_key IN
    ('cron.defaultStoreKey', 'state.schema.contentVersion');
    UPDATE schema_meta SET schema_version = ${previousVersion};
    PRAGMA user_version = ${previousVersion};`);
  seedPartition(legacy, storeKey, jobs);
  return { root, stateDir, options, databasePath, storeKey };
}

function replaceClosedFile(databasePath: string) {
  const copy = `${databasePath}.copy`;
  copyFileSync(databasePath, copy);
  renameSync(copy, databasePath);
}

it("gives fresh state a durable path-derived identity and resolves legacy config-directory precedence", () => {
  const root = tempDirs.make("cron-identity-fresh-");
  const db = openState({ env: { OPENCLAW_STATE_DIR: root } });
  expect(readCronDefaultStoreKeyInDatabase(db.db)).toBe(path.join(root, "cron", "jobs.json"));
  expect(
    resolveLegacyCronDefaultStoreKey({
      OPENCLAW_CONFIG_PATH: path.join(root, "external", "config.json"),
    }),
  ).toBe(path.join(root, "external", "cron", "jobs.json"));
  expect(
    resolveLegacyCronDefaultStoreKey({
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: "/ignored/config.json",
    }),
  ).toBe(path.join(root, "cron", "jobs.json"));
});

it("preserves an upgraded partition and receipt bytes across a stopped state-directory move", async () => {
  const fixture = legacyStore();
  replaceClosedFile(fixture.databasePath);
  await withStateMigrationBackupForTest(fixture.options, () => openState(fixture.options));
  const migrated = openState(fixture.options);
  expect(readCronDefaultStoreKeyInDatabase(migrated.db)).toBe(fixture.storeKey);
  const inventory = readCronStorePartitionInventoryInDatabase(migrated.db);
  expect(inventory).toEqual([
    {
      storeKey: fixture.storeKey,
      jobs: 1,
      scratch: 1,
      receipts: 1,
      history: 1,
      quarantine: 1,
      proactiveReceipts: 1,
    },
  ]);
  closeState();
  const moved = path.join(fixture.root, "moved");
  renameSync(fixture.stateDir, moved);
  const reopened = openState({ env: { OPENCLAW_STATE_DIR: moved } });
  expect(readCronDefaultStoreKeyInDatabase(reopened.db)).toBe(fixture.storeKey);
  expect(readCronStorePartitionInventoryInDatabase(reopened.db)).toEqual(inventory);
  expect(
    reopened.db.prepare("SELECT receipt_id, request_run_id FROM cron_run_receipts").get(),
  ).toMatchObject({ receipt_id: "cron-slot-v1.saved-identity", request_run_id: "request-id" });
  expect(reopened.db.prepare("SELECT content, revision FROM cron_job_scratch").get()).toMatchObject(
    { content: null, revision: 7 },
  );
  expect(reopened.db.prepare("PRAGMA user_version").get()).toMatchObject({
    user_version: OPENCLAW_STATE_SCHEMA_VERSION,
  });
});

it.each([32, 33])(
  "upgrades already-moved v%s state without guessing or refusing database startup",
  async (previousVersion) => {
    const fixture = legacyStore(true, previousVersion);
    const moved = path.join(fixture.root, "already-moved");
    renameSync(fixture.stateDir, moved);
    const options = { env: { OPENCLAW_STATE_DIR: moved } };
    await withStateMigrationBackupForTest(options, () => openState(options));
    const migrated = openState(options);
    expect(readCronDefaultStoreKeyInDatabase(migrated.db)).toBeUndefined();
    expect(readCronStorePartitionInventoryInDatabase(migrated.db)).toMatchObject([
      { storeKey: fixture.storeKey, jobs: 1 },
    ]);
    expect(migrated.db.prepare("PRAGMA user_version").get()).toMatchObject({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
  },
);

it("uses retained history, scratch, quarantine and provisioning evidence after all jobs were removed", async () => {
  const fixture = legacyStore(false);
  replaceClosedFile(fixture.databasePath);
  await withStateMigrationBackupForTest(fixture.options, () => openState(fixture.options));
  expect(readCronDefaultStoreKeyInDatabase(openState(fixture.options).db)).toBe(fixture.storeKey);
});

it.each([false, true])("preserves history-only legacy partitions (moved: %s)", async (moved) => {
  const fixture = legacyStore(false, 32);
  {
    using db = new DatabaseSync(fixture.databasePath);
    db.exec(`DELETE FROM cron_job_scratch;
      DELETE FROM cron_run_receipts;
      DELETE FROM task_runs;
      DELETE FROM diagnostic_events;
      DELETE FROM config_machine_state;
      CREATE TABLE cron_run_logs (
        store_key TEXT NOT NULL, job_id TEXT NOT NULL, seq INTEGER NOT NULL,
        ts INTEGER NOT NULL, entry_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (store_key, job_id, seq));`);
    db.prepare("INSERT INTO cron_run_logs VALUES (?, 'deleted-job', 1, 1000, ?, 1000)").run(
      fixture.storeKey,
      JSON.stringify({ ts: 1000, jobId: "deleted-job", action: "finished", status: "ok" }),
    );
  }
  const destination = moved ? path.join(fixture.root, "moved") : fixture.stateDir;
  if (moved) {
    renameSync(fixture.stateDir, destination);
  } else {
    replaceClosedFile(fixture.databasePath);
  }
  const options = { env: { OPENCLAW_STATE_DIR: destination } };
  await withStateMigrationBackupForTest(options, () => openState(options));
  const { db } = openState(options);
  expect(readCronDefaultStoreKeyInDatabase(db)).toBe(moved ? undefined : fixture.storeKey);
  expect(readCronStorePartitionInventoryInDatabase(db)).toMatchObject([
    { storeKey: fixture.storeKey, jobs: 0, history: 1 },
  ]);
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name='cron_run_logs'").get(),
  ).toBeUndefined();
  const history = db.prepare("SELECT detail_json FROM task_runs WHERE runtime='cron'").get();
  expect(JSON.parse(String(history?.detail_json))).toMatchObject({ storeKey: fixture.storeKey });
  if (moved) {
    selectCronDefaultStoreIdentityInDatabase(db, fixture.storeKey);
    expect(readCronDefaultStoreKeyInDatabase(db)).toBe(fixture.storeKey);
  }
});

it("rolls back the binding with failed schema publication", async () => {
  const fixture = legacyStore();
  {
    using db = new DatabaseSync(fixture.databasePath);
    db.exec(`CREATE TRIGGER refuse_cron_identity_publication BEFORE UPDATE ON schema_meta
      BEGIN SELECT RAISE(ABORT, 'fixture publication refusal'); END;`);
  }
  replaceClosedFile(fixture.databasePath);
  await expect(
    withStateMigrationBackupForTest(fixture.options, () => openState(fixture.options)),
  ).rejects.toThrow("fixture publication refusal");
  using after = new DatabaseSync(fixture.databasePath, { readOnly: true });
  expect(readCronDefaultStoreKeyInDatabase(after)).toBeUndefined();
  expect(after.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 33 });
  expect(after.prepare("SELECT store_key FROM cron_jobs").get()).toMatchObject({
    store_key: fixture.storeKey,
  });
});

it("preserves an existing malformed binding for visible explicit repair", () => {
  const root = tempDirs.make("cron-identity-invalid-");
  const databasePath = path.join(root, "state.sqlite");
  mkdirSync(root, { recursive: true });
  using db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER);
    INSERT INTO config_machine_state VALUES ('cron.defaultStoreKey', '{}', 1);`);
  expect(
    migrateCronDefaultStoreIdentity(db, {
      previousVersion: 33,
      legacyDefaultStoreKey: "/old/cron/jobs.json",
    }),
  ).toBe(false);
  expect(readCronDefaultStoreKeyInDatabase(db)).toBeUndefined();
  expect(db.prepare("SELECT value_json FROM config_machine_state").get()).toMatchObject({
    value_json: "{}",
  });
  selectCronDefaultStoreIdentityInDatabase(db, "/selected/cron/jobs.json", 5);
  expect(readCronDefaultStoreKeyInDatabase(db)).toBe("/selected/cron/jobs.json");
  expect(() => selectCronDefaultStoreIdentityInDatabase(db, "/other/cron/jobs.json", 6)).toThrow(
    "already bound",
  );
});
