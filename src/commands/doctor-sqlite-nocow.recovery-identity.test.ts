import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { completeDoctorMigrationBackups } from "./doctor-migration-backup-artifacts.js";
import { backupDoctorMigrationDatabases } from "./doctor-migration-backup.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
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
// Supply only the later-update gate; backup, rewrite, and retirement use their real owners.
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

function readTarget() {
  return readSessionSqliteMigrationManifest(listSessionSqliteMigrationManifestPaths(env)[0]!)!
    .targets[0]!;
}

async function prepareCompletedBackup() {
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: () => {},
  });
  try {
    await maintenance.run(async () => {
      await backupDoctorMigrationDatabases({
        env,
        pendingDatabasePaths: [shared],
        databasePaths: [shared],
      });
      completeDoctorMigrationBackups(env, [shared]);
    });
  } finally {
    await maintenance.close();
  }
  return readTarget().plannedMoves[0]!.archivePath;
}

function rewrite() {
  return repairDoctorSqliteNoCow({ paths: [shared], stateDir: root, env, assertCurrent: () => {} });
}

function retire() {
  return retireSessionSqliteRecovery({
    env,
    preview: inspectSessionSqliteRecovery({ cfg: {}, env }),
    readConfig: async () => ({}),
    confirm: async () => true,
  });
}

describe("Doctor NOCOW recovery identities", () => {
  beforeEach(async () => {
    root = tempDirs.make("openclaw-nocow-recovery-");
    shared = path.join(root, "state", "openclaw.sqlite");
    env = { ...process.env, OPENCLAW_STATE_DIR: root };
    seedDatabase(shared);
    createDoctorNoCowToolFixture(root);
    const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const tools = vi.mocked(spawnSync).getMockImplementation()!;
    vi.mocked(spawnSync).mockImplementation((command, args, options) =>
      command === process.execPath
        ? native.spawnSync(command, args, options)
        : tools(command, args, options),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("retires a recorded recovery original after a NOCOW rewrite without changing live data", async () => {
    const backupPath = await prepareCompletedBackup();
    const original = fs.readFileSync(backupPath);
    const recorded = readTarget().plannedMoves[0]!.artifact!.identity;
    expect((await rewrite()).warnings).toEqual([]);
    expect(String(fs.lstatSync(backupPath, { bigint: true }).ino)).toBe(recorded.ino);
    expect(fs.readFileSync(backupPath)).toEqual(original);

    const result = await retire();
    expect(result.artifacts.find((item) => item.path === backupPath)).toMatchObject({
      outcome: "removed",
      reason: "rollback-original-retired",
    });
    expect(fs.existsSync(backupPath)).toBe(false);
    const database = new DatabaseSync(shared, { readOnly: true });
    try {
      expect(database.prepare("SELECT value FROM preserved").get()?.value).toBe("before migration");
    } finally {
      database.close();
    }
  });

  it.each(["destination", "backup", "backup metadata"])(
    "keeps the original protected after changing %s",
    async (change) => {
      const backupPath = await prepareCompletedBackup();
      const recorded = readTarget();
      if (change === "destination" || change === "backup") {
        const replacedPath = change === "destination" ? shared : backupPath;
        const replacement = path.join(root, "replacement.sqlite");
        fs.copyFileSync(replacedPath, replacement);
        fs.renameSync(replacement, replacedPath);
      } else if (change === "backup metadata") {
        const touched = new Date("2030-01-01T00:00:00Z");
        fs.utimesSync(backupPath, touched, touched);
      }
      const rewritten = await rewrite();
      expect(rewritten.changes).toHaveLength(1);
      if (change === "destination") {
        expect(rewritten.warnings.join("\n")).toContain("left unchanged");
      } else {
        expect(rewritten.warnings).toEqual([]);
      }
      if (change === "destination") {
        expect(readTarget().databaseIdentity).toEqual(recorded.databaseIdentity);
      } else {
        expect(readTarget().plannedMoves[0]!.artifact!.identity).toEqual(
          recorded.plannedMoves[0]!.artifact!.identity,
        );
      }
      const result = await retire();
      expect(result.artifacts.find((item) => item.path === backupPath)).toMatchObject({
        outcome: "blocked",
        reason:
          change === "destination"
            ? "destination-verification-failed"
            : "artifact-metadata-changed",
      });
      expect(fs.existsSync(backupPath)).toBe(true);
    },
  );
});
