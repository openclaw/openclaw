import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "../infra/sqlite-readonly-location.js";
import { createPluginDoctorStateMigrationContext } from "../infra/state-migrations.plugin-doctor-context.js";
import type { PluginDoctorStateMigration } from "../plugins/doctor-contract-module.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { admitOpenClawMaintenanceLiveAuthorityReads } from "../state/openclaw-state-maintenance-context.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";

const inspection = vi.hoisted(() => ({ stagingRoot: "", onRead: () => {} }));

// mock-isolation: Keep real copying and queries; intercept their boundaries to
// schedule same-process commits without timers or worker scheduling races.
vi.mock("../infra/sqlite-snapshot-source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-snapshot-source.js")>();
  return {
    ...actual,
    prepareSqliteReadOnlyLocation: async (pathname: string) =>
      prepareSqliteReadOnlyLocationSyncInProcess(pathname, inspection.stagingRoot),
  };
});
vi.mock("../state/openclaw-state-db-schema-helpers.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../state/openclaw-state-db-schema-helpers.js")>();
  return {
    ...actual,
    tableExists: (...args: Parameters<typeof actual.tableExists>) => {
      const exists = actual.tableExists(...args);
      if (args[1] === "task_runs") {
        inspection.onRead();
      }
      return exists;
    },
  };
});
vi.mock("../infra/sqlite-snapshot-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-snapshot-policy.js")>();
  return { ...actual, waitForSnapshotRetrySync: () => {} };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    inspection.onRead = () => {};
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

async function fixture() {
  const stateDir = tempDirs.make("openclaw-doctor-native-inspection-");
  inspection.stagingRoot = tempDirs.make("openclaw-doctor-native-snapshots-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const opened = openOpenClawStateDatabase({ env });
  const { db } = opened;
  db.exec(`
    INSERT INTO task_runs (
      task_id, runtime, task_kind, source_id, owner_key, scope_kind, task,
      status, delivery_status, notify_policy, created_at
    ) VALUES ('native-child', 'subagent', 'codex-native', 'native-child',
      'agent:main:parent', 'session', 'Synthetic child', 'running', 'pending', 'silent', 1);
    INSERT INTO state_leases (scope, lease_key, owner, expires_at, created_at, updated_at)
      VALUES ('maintenance', 'synthetic', 'doctor', 100000, 1, 1);
  `);
  let writes = 0;
  const renew = () => {
    const result = db
      .prepare("UPDATE state_leases SET expires_at = expires_at + 1, updated_at = updated_at + 1")
      .run();
    expect(result.changes).toBe(1);
    writes += 1;
  };
  // Run the production copy algorithm in-process so every copy can interleave
  // a real commit deterministically, without timers or a large database.
  const fsync = fs.fsyncSync.bind(fs);
  vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
    fsync(descriptor);
    renew();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    // Keep a live WAL generation after the checkpoint, as later renewals do.
    renew();
  });
  inspection.onRead = renew;
  const contract = await loadBundledPluginFacade<{
    stateMigrations: PluginDoctorStateMigration[];
  }>({ pluginId: "codex", artifactBasename: "doctor-contract-api.js" });
  const migration = contract.stateMigrations.find(
    (entry) => entry.id === "codex-native-task-assignments",
  );
  if (!migration) {
    throw new Error("Codex native assignment migration is missing");
  }
  const params = {
    config: {},
    env,
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context: createPluginDoctorStateMigrationContext({ pluginId: "codex", config: {}, env }),
  };
  return { opened, migration, params, writes: () => writes };
}

it("detects native assignments while Doctor commits state writes and sees later settlement", async () => {
  const { opened, migration, params, writes } = await fixture();
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: () => {},
    assertDatabaseAccess: (pathname) => expect(pathname).toBe(opened.path),
  });
  try {
    await maintenance.run(async () => {
      admitOpenClawMaintenanceLiveAuthorityReads(opened.path);
      await expect(migration.detectLegacyState(params)).resolves.toEqual({
        preview: ["- Preserve native Codex child recovery before retiring Tasks"],
      });
      expect(writes()).toBeGreaterThan(0);
      opened.db.exec("UPDATE task_runs SET delivery_status = 'delivered'");
      await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    });
  } finally {
    await maintenance.close();
  }
});

it("keeps the instability refusal without Doctor's admitted ownership", async () => {
  const { migration, params, writes } = await fixture();
  await expect(migration.detectLegacyState(params)).rejects.toThrow(
    "SQLite source did not stabilize after 10 read-only inspection attempts",
  );
  expect(writes()).toBeGreaterThanOrEqual(10);
});
