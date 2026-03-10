import fs from "node:fs/promises";
import path from "node:path";
import { encryptArchiveToPayload } from "../backup/snapshot-store/encryption.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  buildEnvelope,
  createSnapshotId,
  createTempBackupDir,
  loadResolvedSnapshotBackup,
  resolveSnapshotStore,
  resolveCurrentInstallationId,
  type BackupSnapshotDeps,
} from "./backup-snapshot-shared.js";
import { backupCreateCommand } from "./backup.js";

export type BackupPushOptions = {
  output?: string;
  json?: boolean;
  verify?: boolean;
  snapshotName?: string;
};

export type BackupPushResult = {
  snapshotId: string;
  installationId: string;
  createdAt: string;
  archivePath?: string;
  verified: boolean;
};

export async function backupPushCommand(
  runtime: RuntimeEnv,
  opts: BackupPushOptions,
  deps?: BackupSnapshotDeps,
): Promise<BackupPushResult> {
  const { snapshotStore, stateDir } = await loadResolvedSnapshotBackup({});
  const installationId = await resolveCurrentInstallationId({
    stateDir,
    createIfMissing: true,
  });
  if (!installationId) {
    throw new Error("Failed to resolve backup installation id.");
  }
  const tempDir = await createTempBackupDir();
  const keepLocalArchive = Boolean(opts.output?.trim());

  try {
    const archiveRuntime: RuntimeEnv = opts.json ? { ...runtime, log: () => {} } : runtime;
    const created = await backupCreateCommand(archiveRuntime, {
      output: keepLocalArchive ? opts.output : tempDir,
      json: false,
      verify: Boolean(opts.verify),
      onlyConfig: false,
      includeWorkspace: true,
    });
    const snapshotId = createSnapshotId(deps?.nowMs);
    const payloadPath = path.join(tempDir, `${snapshotId}.payload.bin`);
    const encrypted = await encryptArchiveToPayload({
      archivePath: created.archivePath,
      payloadPath,
      secret: snapshotStore.encryptionKey,
    });
    const envelope = buildEnvelope({
      snapshotId,
      installationId,
      createdAt: new Date(deps?.nowMs ?? Date.now()).toISOString(),
      archiveRoot: created.archiveRoot,
      archiveCreatedAt: created.createdAt,
      includeWorkspace: created.includeWorkspace,
      verified: created.verified,
      onlyConfig: created.onlyConfig,
      snapshotName: opts.snapshotName?.trim() || undefined,
      encryption: encrypted,
    });
    const storage = await resolveSnapshotStore({ snapshotStore, deps });
    await storage.uploadSnapshot({
      installationId,
      snapshotId,
      envelope,
      payloadPath,
    });

    const result: BackupPushResult = {
      snapshotId,
      installationId,
      createdAt: envelope.createdAt,
      archivePath: keepLocalArchive ? created.archivePath : undefined,
      verified: created.verified,
    };
    runtime.log(
      opts.json
        ? JSON.stringify(result, null, 2)
        : `Wrote encrypted backup snapshot ${snapshotId} for installation ${installationId}`,
    );
    return result;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
