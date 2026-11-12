// Retries the state capture until legacy audit rows are stable around it.
import fs from "node:fs/promises";
import path from "node:path";
import type { BackupResourcePlan } from "../commands/backup-resource-inventory.js";
import { createBackupSqliteSnapshotPlan } from "./backup-sqlite-snapshot.js";
import {
  createLegacyAuditBackupCapture,
  legacyAuditBackupCapturesMatch,
  LegacyAuditBackupStateChangedError,
  type LegacyAuditBackupSnapshot,
} from "./state-migrations.audit-backup.js";
import { withLegacyAuditMigrationLease } from "./state-migrations.audit-coordination.js";

const MAX_LEGACY_AUDIT_CAPTURE_ATTEMPTS = 3;

export type BackupStateSnapshotPlan = {
  legacyAuditSnapshots: LegacyAuditBackupSnapshot[];
  stateSqliteBackup: Awaited<ReturnType<typeof createBackupSqliteSnapshotPlan>>;
};

export async function createLegacyAuditStateSnapshotPlan(params: {
  resources: BackupResourcePlan;
  stateDir: string;
  tempDir: string;
  preserveSourceArtifacts?: boolean;
}): Promise<BackupStateSnapshotPlan> {
  const stateDir = params.stateDir;
  // Legacy audit reconciliation takes a source write lease, unlike private-image capture.
  if (params.preserveSourceArtifacts) {
    throw new Error(
      "Source-artifact-preserving backup requires legacy audit migration to finish before capture; no source write lease was acquired.",
    );
  }

  let lastStateChangeMessage: string | undefined;
  for (let attempt = 0; attempt < MAX_LEGACY_AUDIT_CAPTURE_ATTEMPTS; attempt += 1) {
    const attemptDir = path.join(params.tempDir, `state-snapshot-attempt-${attempt + 1}`);
    const verificationDir = path.join(attemptDir, "legacy-verification");
    await fs.mkdir(attemptDir, { recursive: true });
    try {
      const firstCapture = await withLegacyAuditMigrationLease(stateDir, () =>
        createLegacyAuditBackupCapture({ stateDir, tempDir: attemptDir }),
      );
      const stateSqliteBackup = await createBackupSqliteSnapshotPlan({
        resources: params.resources,
        tempDir: attemptDir,
        legacyAuditSnapshots: firstCapture.snapshots,
        legacyAuditDatabaseWitness: firstCapture.databaseWitness,
      });
      await fs.mkdir(verificationDir, { recursive: true });
      const secondCapture = await withLegacyAuditMigrationLease(stateDir, () =>
        createLegacyAuditBackupCapture({ stateDir, tempDir: verificationDir }),
      );
      if (!legacyAuditBackupCapturesMatch(firstCapture, secondCapture)) {
        throw new LegacyAuditBackupStateChangedError();
      }
      await fs.rm(verificationDir, { recursive: true, force: true });
      return { legacyAuditSnapshots: firstCapture.snapshots, stateSqliteBackup };
    } catch (error) {
      await fs.rm(attemptDir, { recursive: true, force: true });
      if (!(error instanceof LegacyAuditBackupStateChangedError)) {
        throw error;
      }
      lastStateChangeMessage = error.message;
    }
  }
  throw new LegacyAuditBackupStateChangedError(
    `${lastStateChangeMessage ?? "Legacy audit state changed while backup was capturing it"}; retry backup after legacy audit migration settles`,
  );
}
