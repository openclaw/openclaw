import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
  writeSessionSqliteMigrationManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { backupDoctorMigrationDatabases } from "./doctor-migration-backup.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { repairDoctorSqliteNoCow } from "./doctor-sqlite-nocow.js";
import { createDoctorNoCowToolFixture } from "./doctor-sqlite-nocow.test-support.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));
vi.mock("../infra/sqlite-wal-filesystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-wal-filesystem.js")>()),
  isSqlitePathOnBtrfs: vi.fn(() => true),
  setSqliteDirectoryNoCow: vi.fn(),
}));
// Isolate the identity guards: satisfy the later-update gate so cleanup reaches them.
vi.mock("./update-capture-cleanup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-capture-cleanup.js")>()),
  readCompletedUpdateHistory: () => ({
    runs: [],
    latestCompletedStartedAt: Date.now() + 86_400_000,
  }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let shared: string;
let env: NodeJS.ProcessEnv;

function seedDatabase(databasePath: string) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA user_version = 1; CREATE TABLE preserved (value TEXT NOT NULL);");
    database.prepare("INSERT INTO preserved VALUES (?)").run("before migration");
  } finally {
    database.close();
  }
}

function findBackup() {
  return fs
    .readdirSync(path.dirname(shared))
    .filter((name) => name.startsWith(`${path.basename(shared)}.pre-startup-migration-`))
    .map((name) => path.join(path.dirname(shared), name))[0]!;
}

function readManifest() {
  return readSessionSqliteMigrationManifest(listSessionSqliteMigrationManifestPaths(env)[0]!)!;
}

describe("Doctor NOCOW recovery-identity reconciliation", () => {
  beforeEach(() => {
    root = tempDirs.make("openclaw-nocow-recovery-", "/tmp");
    shared = path.join(root, "state", "openclaw.sqlite");
    env = { ...process.env, OPENCLAW_STATE_DIR: root };
    seedDatabase(shared);
    createDoctorNoCowToolFixture(root);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("keeps a recorded recovery original retirable after a NOCOW rewrite", async () => {
    const maintenance = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: () => {},
    });
    try {
      await maintenance.run(() =>
        backupDoctorMigrationDatabases({
          env,
          pendingDatabasePaths: [shared],
          databasePaths: [shared],
        }),
      );
      // Equivalent to completeDoctorMigrationBackups: mark the run finished and validated.
      const manifestPath = listSessionSqliteMigrationManifestPaths(env)[0]!;
      const manifest = readSessionSqliteMigrationManifest(manifestPath)!;
      for (const target of manifest.targets) {
        target.validationBeforeArchive = "passed";
      }
      manifest.completedAt = new Date(Date.now() - 600_000).toISOString();
      writeSessionSqliteMigrationManifest({ manifestPath, manifest });
    } finally {
      await maintenance.close();
    }

    const backupPath = findBackup();
    const recorded = readManifest().targets[0]!.plannedMoves[0]!.artifact!.identity;
    const preview = inspectSessionSqliteRecovery({ cfg: {}, env });
    expect(preview.artifacts.find((item) => item.path === backupPath)).toMatchObject({
      outcome: "candidate",
      reason: "producer-verified-original",
    });

    // Documented maintenance step: `openclaw doctor --fix` rewrites the store with NOCOW.
    const result = await repairDoctorSqliteNoCow({
      paths: [shared],
      stateDir: root,
      env,
      assertCurrent: () => {},
    });
    expect([...result.changes, ...result.warnings].join("\n")).toContain(
      "Rewrote SQLite store directory with NOCOW",
    );

    // Doctor re-records the relocated identity, so the original stays an eligible candidate.
    const rewritten = readManifest().targets[0]!;
    const liveBackup = fs.lstatSync(backupPath, { bigint: true });
    expect(String(liveBackup.ino)).not.toBe(recorded.ino);
    expect(rewritten.plannedMoves[0]!.artifact!.identity).toMatchObject({
      dev: String(liveBackup.dev),
      ino: String(liveBackup.ino),
      mtimeNs: String(liveBackup.mtimeNs),
      sha256: recorded.sha256,
    });
    expect(rewritten.databaseIdentity).toEqual({
      dev: String(fs.lstatSync(shared, { bigint: true }).dev),
      ino: String(fs.lstatSync(shared, { bigint: true }).ino),
    });

    const after = inspectSessionSqliteRecovery({ cfg: {}, env });
    expect(after.artifacts.find((item) => item.path === backupPath)).toMatchObject({
      outcome: "candidate",
      reason: "producer-verified-original",
    });
  });
});
