import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readSessionSqliteMigrationManifest } from "../infra/session-sqlite-migration-manifest.js";
import {
  classifyDoctorMigrationBackupPath,
  doctorMigrationBackupPath,
  isDoctorMigrationBackupPath,
  type DoctorMigrationBackupFormat,
} from "./doctor-migration-backup-names.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const db = "/state/openclaw.sqlite";
const id = "0b6f3c1e-8f2a-4c1d-9e3b-5a7d2c4f6e81";
const formats: DoctorMigrationBackupFormat[] = ["full", "scoped", "postgres", "restart-recovery"];

describe("Doctor migration backup names", () => {
  it("classifies every name Doctor produces", () => {
    expect(formats.map((format) => doctorMigrationBackupPath(db, id, format))).toEqual([
      `${db}.pre-startup-migration-${id}.bak`,
      `${db}.pre-startup-migration-${id}.scoped.bak`,
      `${db}.pre-startup-migration-${id}.postgres.bak`,
      `${db}.pre-startup-migration-restart-recovery-${id}.bak`,
    ]);
    for (const format of formats) {
      const name = doctorMigrationBackupPath(db, id, format);
      expect(classifyDoctorMigrationBackupPath(db, name)).toBe(format);
      expect(isDoctorMigrationBackupPath(db, name)).toBe(true);
      expect(isDoctorMigrationBackupPath("/state/other.sqlite", name)).toBe(false);
    }
  });

  it("rejects look-alike names", () => {
    for (const name of [
      `${db}.pre-startup-migration-notes.bak`,
      `${db}.pre-startup-migration-restart-recovery-notes.bak`,
      `${db}.pre-startup-migration-restart-recovery-${id}.scoped.bak`,
      `${db}.pre-startup-migration-${id}.postgres.bak.tmp`,
      `${db}.pre-startup-migration-${id}.sqlite.bak`,
      `${db}-wal.pre-startup-migration-${id}.bak`,
    ]) {
      expect(isDoctorMigrationBackupPath(db, name)).toBe(false);
    }
  });

  it("keeps restore manifests to SQLite file originals", () => {
    const dir = dirs.make("migration-backup-names-");
    const sqlitePath = path.join(dir, "openclaw.sqlite");
    const restorable = formats.map((format) => {
      const archivePath = doctorMigrationBackupPath(sqlitePath, id, format);
      const move = {
        kind: "database-backup",
        sourcePath: sqlitePath,
        archivePath,
        artifact: {
          identity: { dev: "1", ino: "2", mtimeNs: "3", size: 4, sha256: "a".repeat(64) },
          classification: "repair-original",
          reason: "pre-startup-migration-backup",
          dependencies: [],
          disposal: { state: "retained" },
        },
      };
      const manifestPath = path.join(dir, `${format}.json`);
      const manifest = {
        manifestVersion: 3,
        openClawVersion: "2026.11.0",
        runId: `startup-migration-${id}`,
        startedAt: "2026-11-09T00:00:00.000Z",
        targets: [
          {
            agentId: "startup-migration",
            storePath: sqlitePath,
            sqlitePath,
            databaseIdentity: { dev: "1", ino: "5" },
            plannedMoves: [move],
            completedMoves: [move],
            issues: [],
            validationBeforeArchive: "not_run",
          },
        ],
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      return readSessionSqliteMigrationManifest(manifestPath) !== undefined;
    });
    expect(restorable).toEqual([true, true, false, false]);
  });
});
