import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import { inspectScopedMigrationSnapshot } from "../infra/sqlite-migration-scoped-snapshot.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { resolveSchemaMigrationBackupTables } from "../state/schema-migration-backup-scope.js";
import * as backupArtifacts from "./doctor-migration-backup-artifacts.js";
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
vi.mock("../state/schema-migration-backup-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/schema-migration-backup-scope.js")>()),
  resolveSchemaMigrationBackupTables: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const declaredTables = ["schema_meta", "small"];
let fixture: ReturnType<typeof createFixture>;
afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.mocked(resolveSchemaMigrationBackupTables).mockReset().mockReturnValue(declaredTables);
  fixture = createFixture();
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
  versionMigrationsOnly = true,
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
        versionMigrationsOnly,
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

function observeRegistration(
  before?: (inventory: Parameters<typeof backupArtifacts.recordDoctorMigrationBackups>[2]) => void,
) {
  const reads = new Map<string, number>();
  let active = new Map<string, string>();
  const read = fs.readSync;
  vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof read>) => {
    const count = read(...args);
    if (active.size > 0) {
      const stat = fs.fstatSync(args[0], { bigint: true });
      const archive = active.get(`${stat.dev}:${stat.ino}`);
      if (archive) {
        reads.set(archive, reads.get(archive)! + count);
      }
    }
    return count;
  });
  const record = backupArtifacts.recordDoctorMigrationBackups;
  vi.spyOn(backupArtifacts, "recordDoctorMigrationBackups").mockImplementation((...args) => {
    before?.(args[2]);
    active = new Map(
      args[2].map(({ archivePath }) => {
        const stat = fs.statSync(archivePath, { bigint: true });
        reads.set(archivePath, 0);
        return [`${stat.dev}:${stat.ino}`, archivePath];
      }),
    );
    try {
      return record(...args);
    } finally {
      active.clear();
    }
  });
  return reads;
}

function expectRegisteredContent(env: NodeJS.ProcessEnv) {
  const manifests = listSessionSqliteMigrationManifestPaths(env);
  expect(manifests).toHaveLength(1);
  const manifest = readSessionSqliteMigrationManifest(manifests[0]!)!;
  for (const move of manifest.targets.flatMap((target) => target.completedMoves)) {
    const bytes = fs.readFileSync(move.archivePath);
    const stat = fs.lstatSync(move.archivePath, { bigint: true });
    expect(move.artifact?.identity).toEqual({
      dev: String(stat.dev),
      ino: String(stat.ino),
      mtimeNs: String(stat.mtimeNs),
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
}

describe("Doctor table-scoped migration backup selection", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "registers backups with publication caching (scoped=%s, retained=%s)",
    async (scoped, retained) => {
      const originals = [fixture.agent, fixture.shared].map((file) => fs.readFileSync(file));
      if (retained) {
        await backup(scoped);
        for (const manifest of listSessionSqliteMigrationManifestPaths(fixture.env)) {
          fs.unlinkSync(manifest);
        }
      }
      const reads = observeRegistration();
      const result = await backup(scoped);
      expect(result.warnings).toEqual([]);
      expect(reads.size).toBe(2);
      expectRegisteredContent(fixture.env);
      expect([fixture.agent, fixture.shared].map((file) => fs.readFileSync(file))).toEqual(
        originals,
      );
      if (!scoped && !retained) {
        expect(result.versionMigrations).toBeUndefined();
        expectFullBackup(fixture.agent);
        expectFullBackup(fixture.shared);
      }
      if (retained) {
        for (const [archive, bytes] of reads) {
          expect(bytes).toBe(fs.statSync(archive).size);
        }
        await backup(scoped);
      }
      expect([...reads.values()]).toEqual([0, 0]);
    },
  );

  it.each(["same-size edit", "replacement", "hard link", "symlink"] as const)(
    "does not reuse stale publication content after a %s before registration",
    async (change) => {
      let changedArchive = "";
      const reads = observeRegistration((inventory) => {
        changedArchive = inventory.find(
          ({ path: source }) => source === fixture.agent,
        )!.archivePath;
        const original = fs.statSync(changedArchive);
        const bytes = fs.readFileSync(changedArchive);
        const offset = bytes.indexOf("before migration");
        expect(offset).toBeGreaterThanOrEqual(0);
        bytes[offset] = "B".charCodeAt(0);
        if (change === "same-size edit") {
          fs.writeFileSync(changedArchive, bytes);
          fs.utimesSync(changedArchive, original.atime, original.mtime);
        } else if (change === "replacement") {
          const replacement = `${changedArchive}.replacement`;
          fs.writeFileSync(replacement, bytes);
          fs.renameSync(replacement, changedArchive);
        } else if (change === "hard link") {
          fs.linkSync(changedArchive, `${changedArchive}.alias`);
        } else {
          fs.renameSync(changedArchive, `${changedArchive}.original`);
          fs.symlinkSync(`${changedArchive}.original`, changedArchive);
        }
      });
      const result = await backup(false);
      if (change === "hard link" || change === "symlink") {
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain("not an unaliased regular file");
        expect(listSessionSqliteMigrationManifestPaths(fixture.env)).toEqual([]);
        expect(fs.lstatSync(changedArchive)).toBeDefined();
      } else {
        expect(result.warnings).toEqual([]);
        expect(reads.get(changedArchive)).toBe(fs.statSync(changedArchive).size);
        expectRegisteredContent(fixture.env);
      }
    },
  );

  it("restores a failed scoped migration through Doctor without overwriting unrelated writes", async () => {
    const result = await backup();
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
    expect(recovery.artifacts).toContainEqual(
      expect.objectContaining({
        path: archive,
        outcome: "protected",
        reason: "incomplete-recovery-operation",
      }),
    );

    {
      using migrated = new DatabaseSync(fixture.agent);
      migrated.exec(`
        PRAGMA user_version = 27;
        UPDATE schema_meta SET schema_version = 27;
        UPDATE small SET value = 'after migration';
        UPDATE retained SET value = 'written after backup';
      `);
    }
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
    const secondAgent = path.join(path.dirname(fixture.agent), "second.sqlite");
    seedDatabase(secondAgent);
    const inventory = [fixture.agent, secondAgent];
    await backup(true, inventory);
    const original = listBackups(fixture.agent)[0]!;
    const originalBytes = fs.readFileSync(original);
    {
      using migrated = new DatabaseSync(fixture.agent);
      migrated.exec("PRAGMA user_version = 27; UPDATE small SET value = 'partially migrated'");
    }
    await backup(true, [secondAgent], inventory);
    expect(listBackups(fixture.agent)).toEqual([original]);
    expect(fs.readFileSync(original)).toEqual(originalBytes);
    using live = new DatabaseSync(fixture.agent, { readOnly: true });
    expect(live.prepare("SELECT value FROM small").get()?.value).toBe("partially migrated");
  });

  it.each(["undeclared", "virtual"])(
    "uses full images for the whole group with a %s table scope",
    async (kind) => {
      const secondAgent = path.join(path.dirname(fixture.agent), "second.sqlite");
      seedDatabase(secondAgent);
      if (kind === "undeclared") {
        // Keep the declared first target to detect a partial scope map.
        vi.mocked(resolveSchemaMigrationBackupTables)
          .mockReturnValueOnce(declaredTables)
          .mockReturnValueOnce(undefined);
      } else {
        using virtual = new DatabaseSync(secondAgent);
        virtual.exec(`
        DROP TABLE small;
        CREATE VIRTUAL TABLE small USING fts5(value);
        INSERT INTO small VALUES ('searchable history');
      `);
      }
      await backup(true, [fixture.agent, secondAgent]);
      for (const database of [fixture.agent, secondAgent, fixture.shared]) {
        expectFullBackup(database);
      }
    },
  );

  it("does not reuse a scoped schema archive for a subsequent full-only repair", async () => {
    await backup();
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

  it.each([
    "undeclared",
    "OPENCLAW_UPDATE_IN_PROGRESS",
    "OPENCLAW_UPDATE_POST_CORE_CONVERGENCE",
    "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE",
  ])("replaces scoped images with full images for %s", async (marker) => {
    await backup();
    const earlierBackups = [fixture.agent, fixture.shared].flatMap(listBackups);
    if (marker === "undeclared") {
      vi.mocked(resolveSchemaMigrationBackupTables).mockReturnValue(undefined);
    } else {
      fixture.env[marker] = "1";
    }
    await backup();
    expectFullBackup(fixture.agent, earlierBackups);
    expectFullBackup(fixture.shared, earlierBackups);
  });
});
