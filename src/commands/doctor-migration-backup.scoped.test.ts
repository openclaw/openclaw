import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { inspectScopedMigrationSnapshot } from "../infra/sqlite-migration-scoped-snapshot.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { resolveSchemaMigrationBackupTables } from "../state/schema-migration-backup-scope.js";
import { restoreDoctorMigrationBackup } from "./doctor-migration-backup-restore.js";
import {
  backupDoctorMigrationDatabases,
  backupDoctorSqliteDatabases,
} from "./doctor-migration-backup.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

// These fixtures isolate backup selection; historical schema repair has its own owner tests.
vi.mock("../state/openclaw-state-db-fast-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-db-fast-path.js")>()),
  needsOpenClawStateDatabaseSchemaRepair: () => false,
}));
// mock-isolation: Synthetic scopes isolate backup selection without certifying real migrations.
vi.mock("../state/schema-migration-backup-scope.js", () => ({
  resolveSchemaMigrationBackupTables: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const declaredTables = ["schema_meta", "small"];

beforeEach(() => {
  vi.mocked(resolveSchemaMigrationBackupTables).mockReset().mockReturnValue(declaredTables);
});

function seedDatabase(databasePath: string) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  using database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA user_version = 26;
    CREATE TABLE schema_meta (schema_version INTEGER NOT NULL) STRICT;
    CREATE TABLE small (value TEXT NOT NULL) STRICT;
    CREATE TABLE retained (value TEXT NOT NULL, payload BLOB) STRICT;
    INSERT INTO schema_meta VALUES (26);
    INSERT INTO small VALUES ('before migration');
    INSERT INTO retained VALUES ('untouched', zeroblob(32768));
  `);
}

function createFixture() {
  const stateDir = tempDirs.make("openclaw-doctor-scoped-backup-");
  const shared = path.join(stateDir, "state", "openclaw.sqlite");
  const agent = path.join(stateDir, "agents", "main", "openclaw-agent.sqlite");
  const configPath = path.join(stateDir, "openclaw.json");
  seedDatabase(shared);
  seedDatabase(agent);
  fs.writeFileSync(configPath, "{}\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_UPDATE_IN_PROGRESS: undefined,
    OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
    OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: undefined,
  };
  return { shared, agent, env };
}

function listBackups(databasePath: string) {
  return fs
    .readdirSync(path.dirname(databasePath))
    .filter(
      (name) =>
        name.startsWith(`${path.basename(databasePath)}.pre-startup-migration-`) &&
        name.endsWith(".bak"),
    )
    .map((name) => path.join(path.dirname(databasePath), name));
}

async function backup(
  fixture: ReturnType<typeof createFixture>,
  pendingPaths = [fixture.agent],
  databasePaths = pendingPaths,
) {
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: () => {},
  });
  try {
    return await maintenance.run(() =>
      backupDoctorMigrationDatabases({
        env: fixture.env,
        pendingDatabasePaths: pendingPaths,
        pendingMigrations: pendingPaths.map((pathname) => ({
          kind: "agent",
          path: pathname,
          foundVersion: 26,
          supportedVersion: 27,
        })),
        databasePaths,
      }),
    );
  } finally {
    await maintenance.close();
  }
}

function expectFullBackup(databasePath: string, earlierBackups: readonly string[] = []) {
  const backups = listBackups(databasePath).filter((archive) => !earlierBackups.includes(archive));
  expect(backups).toHaveLength(1);
  expect(backups[0]).not.toMatch(/\.scoped\.bak$/u);
  using saved = new DatabaseSync(backups[0]!, { readOnly: true });
  expect(saved.prepare("SELECT value, length(payload) AS bytes FROM retained").get()).toEqual({
    value: "untouched",
    bytes: 32768,
  });
}

describe("Doctor table-scoped migration backup selection", () => {
  it("restores a failed scoped migration through Doctor without overwriting unrelated writes", async () => {
    const fixture = createFixture();
    const result = await backup(fixture);
    expect(result.warnings).toEqual([]);
    const archives = listBackups(fixture.agent);
    expect(archives).toHaveLength(1);
    const archive = archives[0]!;
    expect(archive).toMatch(/\.scoped\.bak$/u);
    expect(inspectScopedMigrationSnapshot(archive).tables.map((table) => table.name)).toEqual(
      declaredTables,
    );
    expectFullBackup(fixture.shared);
    const recovery = inspectSessionSqliteRecovery({ cfg: {}, env: fixture.env });
    expect(recovery.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: archive,
          outcome: "protected",
          reason: "incomplete-recovery-operation",
        }),
      ]),
    );

    expect(() => {
      using migrated = new DatabaseSync(fixture.agent);
      migrated.exec(`
        PRAGMA user_version = 27;
        UPDATE schema_meta SET schema_version = 27;
        UPDATE small SET value = 'after migration';
        UPDATE retained SET value = 'written after backup';
      `);
      throw new Error("synthetic migration failure after writes");
    }).toThrow("synthetic migration failure after writes");
    await restoreDoctorMigrationBackup({
      sourcePath: fixture.agent,
      backupPath: archive,
      env: fixture.env,
    });
    using restored = new DatabaseSync(fixture.agent, { readOnly: true });
    expect(restored.prepare("SELECT value FROM small").get()?.value).toBe("before migration");
    expect(restored.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version).toBe(
      26,
    );
    expect(restored.prepare("PRAGMA user_version").get()?.user_version).toBe(26);
    expect(restored.prepare("SELECT value FROM retained").get()?.value).toBe(
      "written after backup",
    );
  });

  it("reuses the original scoped image after one database has already migrated", async () => {
    const fixture = createFixture();
    const secondAgent = path.join(path.dirname(fixture.agent), "second.sqlite");
    seedDatabase(secondAgent);
    const inventory = [fixture.agent, secondAgent];
    await backup(fixture, inventory);
    const original = listBackups(fixture.agent)[0]!;
    const originalBytes = fs.readFileSync(original);
    {
      using migrated = new DatabaseSync(fixture.agent);
      migrated.exec("PRAGMA user_version = 27; UPDATE small SET value = 'partially migrated'");
    }
    await backup(fixture, [secondAgent], inventory);
    expect(listBackups(fixture.agent)).toEqual([original]);
    expect(fs.readFileSync(original)).toEqual(originalBytes);
    using live = new DatabaseSync(fixture.agent, { readOnly: true });
    expect(live.prepare("SELECT value FROM small").get()?.value).toBe("partially migrated");
  });

  it("uses full images for the whole group when a pending migration is undeclared", async () => {
    const fixture = createFixture();
    const secondAgent = path.join(path.dirname(fixture.agent), "second.sqlite");
    seedDatabase(secondAgent);
    // Preserve a declared first target to catch a producer that retains a partial scope map.
    vi.mocked(resolveSchemaMigrationBackupTables)
      .mockReturnValueOnce(declaredTables)
      .mockReturnValueOnce(undefined);
    await backup(fixture, [fixture.agent, secondAgent]);
    for (const database of [fixture.agent, secondAgent, fixture.shared]) {
      expectFullBackup(database);
    }
  });

  it("does not reuse a scoped schema archive for a subsequent full-only repair", async () => {
    const fixture = createFixture();
    await backup(fixture);
    const earlierBackups = [fixture.agent, fixture.shared].flatMap(listBackups);
    expect(earlierBackups.some((archive) => archive.endsWith(".scoped.bak"))).toBe(true);
    await withDoctorSqliteMaintenanceLock({
      env: fixture.env,
      operation: "test full-only repair backup",
      protectedPaths: [fixture.agent, fixture.shared],
      run: (authority) =>
        backupDoctorSqliteDatabases({
          env: fixture.env,
          pendingDatabasePaths: [fixture.agent],
          databasePaths: [fixture.agent],
          authority,
        }),
    });
    expectFullBackup(fixture.agent, earlierBackups);
    expectFullBackup(fixture.shared, earlierBackups);
  });

  it("does not reuse a scoped archive when the pending migration has no declaration", async () => {
    const fixture = createFixture();
    await backup(fixture);
    const earlierBackups = [fixture.agent, fixture.shared].flatMap(listBackups);
    vi.mocked(resolveSchemaMigrationBackupTables).mockReturnValue(undefined);
    await backup(fixture);
    expectFullBackup(fixture.agent, earlierBackups);
    expectFullBackup(fixture.shared, earlierBackups);
  });

  it.each([
    "OPENCLAW_UPDATE_IN_PROGRESS",
    "OPENCLAW_UPDATE_POST_CORE_CONVERGENCE",
    "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE",
  ])("preserves full images for the shipped updater marker %s", async (marker) => {
    const fixture = createFixture();
    await backup(fixture);
    const earlierBackups = [fixture.agent, fixture.shared].flatMap(listBackups);
    fixture.env[marker] = "1";
    await backup(fixture);
    expectFullBackup(fixture.agent, earlierBackups);
    expectFullBackup(fixture.shared, earlierBackups);
  });

  it("falls back for the whole group when a declared table is virtual", async () => {
    const fixture = createFixture();
    const secondAgent = path.join(path.dirname(fixture.agent), "second.sqlite");
    seedDatabase(secondAgent);
    {
      using virtual = new DatabaseSync(secondAgent);
      virtual.exec(`
        DROP TABLE small;
        CREATE VIRTUAL TABLE small USING fts5(value);
        INSERT INTO small VALUES ('searchable history');
      `);
    }
    await backup(fixture, [fixture.agent, secondAgent]);
    for (const database of [fixture.agent, secondAgent, fixture.shared]) {
      expectFullBackup(database);
    }
  });
});
