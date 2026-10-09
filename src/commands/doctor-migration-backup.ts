import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import nodePath from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireDirectorySync, syncDirectorySync } from "../infra/directory-durability.js";
import { formatErrorMessage } from "../infra/errors.js";
import { sameFileMutationFingerprint } from "../infra/file-descriptor.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import type { MigrationMessages } from "../infra/state-migrations.types.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { needsOpenClawStateDatabaseSchemaRepair } from "../state/openclaw-state-db-fast-path.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveRuntimeServiceBuildId, resolveRuntimeServiceCommit, VERSION } from "../version.js";
import type { BackupSqliteSnapshotFact } from "./backup-resource-inventory.js";
import { recordDoctorMigrationBackups } from "./doctor-migration-backup-artifacts.js";
import { createDoctorRehearsalDatabaseCoverage } from "./doctor-rehearsal-databases.js";
import type { DoctorSqliteMaintenanceAuthority } from "./doctor-sqlite-maintenance-lock.js";

/** Preserve the old database generation before Doctor advances its schemas. */
export async function backupDoctorMigrationDatabases(params: {
  env: NodeJS.ProcessEnv;
  pendingDatabasePaths: readonly string[];
  /** Complete discovery keeps the retry group stable after some migrations finish. */
  databasePaths: readonly string[];
  verifiedSnapshots?: readonly BackupSqliteSnapshotFact[];
}): Promise<MigrationMessages> {
  const sharedPath = resolveOpenClawStateSqlitePath(params.env);
  const pending = new Set(params.pendingDatabasePaths);
  if (existsSync(sharedPath) && needsOpenClawStateDatabaseSchemaRepair(sharedPath)) {
    pending.add(sharedPath);
  }
  if (pending.size === 0) {
    return { changes: [], warnings: [] };
  }
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (!maintenance?.ownsSchemaMaintenance) {
    throw new Error("Pre-migration SQLite backups require Doctor maintenance ownership.");
  }
  return backupDoctorSqliteDatabases({
    ...params,
    pendingDatabasePaths: [...pending],
    authority: { assertCurrent: () => maintenance.assertAdmission() },
  });
}

/** Schema and same-schema repairs share verified snapshots under their existing Doctor owner. */
export async function backupDoctorSqliteDatabases(params: {
  env: NodeJS.ProcessEnv;
  pendingDatabasePaths: readonly string[];
  databasePaths: readonly string[];
  authority: DoctorSqliteMaintenanceAuthority;
  repair?: { key: string; validate: (database: DatabaseSync) => void };
  verifiedSnapshots?: readonly BackupSqliteSnapshotFact[];
}): Promise<MigrationMessages> {
  const pending = new Set(params.pendingDatabasePaths);
  if (pending.size === 0) {
    return { changes: [], warnings: [] };
  }
  // The registry and migration receipts must roll back with their agent databases.
  const sharedPath = resolveOpenClawStateSqlitePath(params.env);
  if (existsSync(sharedPath)) {
    pending.add(sharedPath);
  }
  const { authority } = params;
  authority.assertCurrent();
  const disposable = createDoctorRehearsalDatabaseCoverage(params.env);
  disposable?.admit([...pending, ...params.databasePaths]);
  const retainedPaths = [...new Set([...pending, ...params.databasePaths])].filter(
    (pathname) => !disposable?.excludes(pathname),
  );
  if (retainedPaths.length === 0) {
    disposable?.assertCurrent();
    return { changes: [], warnings: [] };
  }
  const { createVerifiedSqliteSnapshot } = await import("../infra/sqlite-snapshot.js");
  const { sanitizeOpenClawStateLeaseRows } =
    await import("../state/openclaw-state-snapshot-sanitizer.js");
  authority.assertCurrent();
  disposable?.assertCurrent();
  const sources = [
    ...new Set(
      [...pending]
        .filter((pathname) => !disposable?.excludes(pathname))
        .map((pathname) => realpathSync.native(pathname)),
    ),
  ];
  if (
    sources.length > 0 &&
    sources.every((sourcePath) => {
      const { dev, ino } = statSync(sourcePath);
      return (
        dev !== 0 &&
        ino !== 0 &&
        params.verifiedSnapshots?.some((snapshot) => snapshot.dev === dev && snapshot.ino === ino)
      );
    })
  ) {
    return { changes: [], warnings: [] };
  }
  const inventory = [
    ...new Set([...sources, ...retainedPaths.map((pathname) => realpathSync.native(pathname))]),
  ]
    .toSorted()
    .map((pathname) => ({ path: pathname, identity: statSync(pathname, { bigint: true }) }));
  // File identity and target schemas survive in-place migration; timestamps do not.
  // Preserve the first group, including when a retry has fewer pending databases.
  const backupDigest = createHash("sha256")
    .update(
      JSON.stringify([
        ...(params.repair ? [params.repair.key] : []),
        VERSION,
        resolveRuntimeServiceBuildId(),
        resolveRuntimeServiceCommit(),
        OPENCLAW_STATE_SCHEMA_VERSION,
        OPENCLAW_AGENT_SCHEMA_VERSION,
        inventory.map(({ path, identity }) => [path, String(identity.dev), String(identity.ino)]),
      ]),
    )
    .digest("hex");
  // Preserve the existing UUID-shaped backup names with a deterministic v8 ID.
  const backupId = [
    backupDigest.slice(0, 8),
    backupDigest.slice(8, 12),
    `8${backupDigest.slice(13, 16)}`,
    `8${backupDigest.slice(17, 20)}`,
    backupDigest.slice(20, 32),
  ].join("-");
  const assertInventory = () => {
    authority.assertCurrent();
    disposable?.assertCurrent();
    for (const { path: pathname, identity } of inventory) {
      const current = statSync(pathname, { bigint: true });
      if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new Error(`Pre-migration SQLite backup source changed: ${pathname}`);
      }
    }
  };
  const changes: string[] = [];
  const targetFor = (sourcePath: string) => `${sourcePath}.pre-startup-migration-${backupId}.bak`;
  const anchor = existsSync(sharedPath) ? realpathSync.native(sharedPath) : inventory[0]!.path;
  // This backup artifact is durably removed before migration can start. A missing
  // snapshot alone cannot prove that a surviving rollback group is incomplete.
  const capturePath = `${targetFor(anchor)}.capturing`;
  let capture = lstatSync(capturePath, { bigint: true, throwIfNoEntry: false });
  const hasSnapshots = inventory.some(
    ({ path: sourcePath }) =>
      lstatSync(targetFor(sourcePath), { throwIfNoEntry: false }) !== undefined,
  );
  if (!capture && !hasSnapshots) {
    assertInventory();
    const descriptor = openSync(capturePath, "wx", 0o600);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    capture = lstatSync(capturePath, { bigint: true });
  }
  const assertCapture = () => {
    assertInventory();
    if (
      capture &&
      (!capture.isFile() ||
        capture.size !== 0n ||
        !sameFileMutationFingerprint(capture, lstatSync(capturePath, { bigint: true })))
    ) {
      throw new DoctorMaintenanceRefusalError(
        `Pre-migration SQLite backup capture marker changed: ${capturePath}`,
        { kind: "data-at-risk", reason: "incomplete-migration" },
      );
    }
  };
  const syncCaptureDirectory = () =>
    requireDirectorySync(
      syncDirectorySync(nodePath.dirname(capturePath)),
      "Migration backup directory",
    );
  if (capture) {
    assertCapture();
    syncCaptureDirectory();
    for (const { path: sourcePath } of inventory) {
      const targetPath = targetFor(sourcePath);
      const incomplete = lstatSync(targetPath, { bigint: true, throwIfNoEntry: false });
      if (!incomplete) {
        continue;
      }
      assertCapture();
      if (
        !incomplete.isFile() ||
        !sameFileMutationFingerprint(incomplete, lstatSync(targetPath, { bigint: true }))
      ) {
        throw new Error(`Incomplete pre-migration SQLite backup changed: ${targetPath}`);
      }
      unlinkSync(targetPath);
      changes.push(`Discarded incomplete pre-migration SQLite backup: ${targetPath}`);
    }
  }
  for (const { path: sourcePath } of inventory) {
    assertCapture();
    const targetPath = targetFor(sourcePath);
    const existing = lstatSync(targetPath, { bigint: true, throwIfNoEntry: false });
    if (existing) {
      try {
        if (!existing.isFile()) {
          throw new Error("Backup must be a regular file");
        }
        const snapshot = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(targetPath), {
          readOnly: true,
        });
        try {
          snapshot.exec("PRAGMA trusted_schema = OFF;");
          assertCapture();
          assertSqliteIntegrity(snapshot, targetPath);
          params.repair?.validate(snapshot);
        } finally {
          snapshot.close();
        }
        if (!sameFileMutationFingerprint(existing, lstatSync(targetPath, { bigint: true }))) {
          throw new Error("Backup changed during verification");
        }
      } catch (cause) {
        throw new DoctorMaintenanceRefusalError(
          `Cannot verify pre-migration SQLite backup: ${targetPath}. ${formatErrorMessage(cause)}. Restore the matching backup group before retrying; surviving snapshots were preserved.`,
          { kind: "data-at-risk", reason: "incomplete-migration" },
          { cause },
        );
      }
      changes.push(`Reused pre-migration SQLite backup: ${targetPath}`);
      continue;
    }
    if (!capture) {
      throw new DoctorMaintenanceRefusalError(
        `Completed pre-migration SQLite backup group is missing: ${targetPath}. Restore the matching backup group before retrying; surviving snapshots were preserved.`,
        { kind: "data-at-risk", reason: "incomplete-migration" },
      );
    }
    const backup = await createVerifiedSqliteSnapshot({
      sourcePath,
      targetPath,
      preserveRowIds: true,
      transform: sanitizeOpenClawStateLeaseRows,
      beforePublish: assertCapture,
      validate: params.repair?.validate,
    });
    assertCapture();
    changes.push(`Saved pre-migration SQLite backup: ${backup.path}`);
  }
  assertCapture();
  if (capture) {
    unlinkSync(capturePath);
  }
  // Reuse must finish any prior attempt's failed sync after marker removal too.
  syncCaptureDirectory();
  assertInventory();
  if (lstatSync(capturePath, { throwIfNoEntry: false })) {
    throw new DoctorMaintenanceRefusalError(
      `Pre-migration SQLite backup capture marker appeared during verification: ${capturePath}`,
      { kind: "data-at-risk", reason: "incomplete-migration" },
    );
  }
  const warnings: string[] = [];
  try {
    recordDoctorMigrationBackups(params.env, backupId, inventory);
  } catch (error) {
    warnings.push(
      `Migration backups remain protected; cleanup registration failed: ${formatErrorMessage(error)}`,
    );
  }
  return { changes, warnings };
}
