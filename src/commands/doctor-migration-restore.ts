import fs, { type BigIntStats } from "node:fs";
import { formatErrorMessage } from "../infra/errors.js";
import { sameFileMutationFingerprint } from "../infra/file-descriptor.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import { backupNodeSqliteDatabase } from "../infra/sqlite-backup.js";
import { retireSqliteDatabaseAdmissionForPath } from "../infra/sqlite-database-admission.js";
import { assertExpectedContent, hashPublishedFileSync } from "../infra/sqlite-snapshot-file.js";
import { createVerifiedSqliteSnapshot } from "../infra/sqlite-snapshot.js";
import { readDatabaseIdentityBirthtime } from "../infra/sqlite-worker-identity.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";

export type DoctorMigrationBackup = {
  id: string;
  sourceFiles: Array<{ path: string; identity: BigIntStats | undefined }>;
  /** Missing for a reused group: it may predate writes from an earlier Doctor run. */
  snapshots?: Array<{
    path: string;
    snapshotPath: string;
    sha256: string;
    sizeBytes: number;
  }>;
};

export function doctorMigrationDatabasesChanged(backup: DoctorMigrationBackup): boolean {
  return backup.sourceFiles.some(({ path, identity }) => {
    const current = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });
    return identity
      ? !current || !sameFileMutationFingerprint(identity, current)
      : current !== undefined;
  });
}

/** The caller retains offline custody and has drained every Doctor resource. */
export async function restoreDoctorMigrationDatabases(
  backup: DoctorMigrationBackup,
  assertCurrent: () => void,
): Promise<string[]> {
  const snapshots = backup.snapshots;
  if (!snapshots) {
    throw new DoctorMaintenanceRefusalError(
      `Doctor cannot automatically restore reused pre-migration backup group ${backup.id}; it may predate later writes. Keep the Gateway stopped and restore the matching backup group before retrying.`,
      { kind: "data-at-risk", reason: "incomplete-migration" },
    );
  }
  const retained: string[] = [];
  try {
    for (const snapshot of snapshots) {
      assertCurrent();
      const before = backup.sourceFiles.find(({ path }) => path === snapshot.path)!.identity!;
      const current = fs.lstatSync(snapshot.path, { bigint: true });
      if (
        !current.isFile() ||
        current.nlink !== 1n ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        readDatabaseIdentityBirthtime(current) !== readDatabaseIdentityBirthtime(before)
      ) {
        throw new Error(
          `Database was replaced or aliased after its pre-migration backup: ${snapshot.path}`,
        );
      }
      assertExpectedContent(
        hashPublishedFileSync(
          snapshot.snapshotPath,
          fs.lstatSync(snapshot.snapshotPath, { bigint: true }),
        ),
        snapshot,
        snapshot.snapshotPath,
      );
      const refused = await createVerifiedSqliteSnapshot({
        sourcePath: snapshot.path,
        targetPath: `${snapshot.path}.doctor-refused-${backup.id}.bak`,
        preserveRowIds: true,
        beforePublish: assertCurrent,
      });
      retained.push(refused.path);
    }
    // Preserve the whole refused group before SQLite transactionally restores each file.
    for (const snapshot of snapshots) {
      await closeOpenClawStateDatabaseByPathAsync(snapshot.path);
      assertCurrent();
      retireSqliteDatabaseAdmissionForPath(snapshot.path, { requireSoleDescriptor: true });
      const source = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(snapshot.snapshotPath), {
        readOnly: true,
      });
      try {
        assertCurrent();
        await backupNodeSqliteDatabase(source, snapshot.path, assertCurrent);
      } finally {
        source.close();
      }
      assertCurrent();
      retireSqliteDatabaseAdmissionForPath(snapshot.path, { requireSoleDescriptor: true });
    }
  } catch (cause) {
    throw new DoctorMaintenanceRefusalError(
      `Doctor could not restore pre-migration backup group ${backup.id}: ${formatErrorMessage(cause)}. Keep the Gateway stopped; restore the matching .pre-startup-migration-${backup.id}.bak files together. Refused-state snapshots retained at: ${retained.join(", ") || "none"}.`,
      { kind: "data-at-risk", reason: "incomplete-migration" },
      { cause },
    );
  }
  return retained;
}
