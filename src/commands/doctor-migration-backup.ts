import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import type { MigrationMessages } from "../infra/state-migrations.types.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { BackupSqliteSnapshotFact } from "./backup-resource-inventory.js";

/** Preserve the old database generation before Doctor advances its schemas. */
export async function backupDoctorMigrationDatabases(params: {
  env: NodeJS.ProcessEnv;
  pendingDatabasePaths: readonly string[];
  verifiedSnapshots?: readonly BackupSqliteSnapshotFact[];
}): Promise<MigrationMessages> {
  const { detectOpenClawStateDatabaseSchemaMigrations } =
    await import("../state/openclaw-state-db-schema-discovery.js");
  const sharedPath = resolveOpenClawStateSqlitePath(params.env);
  const pending = new Set(params.pendingDatabasePaths);
  if (detectOpenClawStateDatabaseSchemaMigrations({ env: params.env }).length > 0) {
    pending.add(sharedPath);
  }
  if (pending.size === 0) {
    return { changes: [], warnings: [] };
  }
  // The registry and migration receipts must roll back with their agent databases.
  if (existsSync(sharedPath)) {
    pending.add(sharedPath);
  }
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (!maintenance?.ownsSchemaMaintenance) {
    throw new Error("Pre-migration SQLite backups require Doctor maintenance ownership.");
  }
  maintenance.assertAdmission();
  const { createVerifiedSqliteSnapshot } = await import("../infra/sqlite-snapshot.js");
  const { sanitizeOpenClawStateLeaseRows } =
    await import("../state/openclaw-state-snapshot-sanitizer.js");
  maintenance.assertAdmission();
  const backupId = randomUUID();
  const changes: string[] = [];
  for (const sourcePath of new Set([...pending].map((pathname) => realpathSync.native(pathname)))) {
    maintenance.assertAdmission();
    const identity = statSync(sourcePath);
    if (
      identity.dev !== 0 &&
      identity.ino !== 0 &&
      params.verifiedSnapshots?.some(
        (snapshot) => snapshot.dev === identity.dev && snapshot.ino === identity.ino,
      )
    ) {
      continue;
    }
    const backup = await createVerifiedSqliteSnapshot({
      sourcePath,
      targetPath: `${sourcePath}.pre-startup-migration-${backupId}.bak`,
      preserveRowIds: true,
      transform: sanitizeOpenClawStateLeaseRows,
      beforePublish: () => maintenance.assertAdmission(),
    });
    maintenance.assertAdmission();
    changes.push(`Saved pre-migration SQLite backup: ${backup.path}`);
  }
  return { changes, warnings: [] };
}
