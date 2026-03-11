import type { RuntimeEnv } from "../runtime.js";
import {
  loadResolvedSnapshotBackupTarget,
  resolveSnapshotListStore,
  resolveCurrentInstallationId,
  toSnapshotListEntry,
  type BackupSnapshotDeps,
} from "./backup-snapshot-shared.js";

export type BackupListOptions = {
  json?: boolean;
};

export type BackupListResult = {
  installationId?: string;
  snapshots: ReturnType<typeof toSnapshotListEntry>[];
};

export async function backupListCommand(
  runtime: RuntimeEnv,
  opts: BackupListOptions,
  deps?: BackupSnapshotDeps,
): Promise<BackupListResult> {
  const { snapshotStore, stateDir } = await loadResolvedSnapshotBackupTarget({});
  const installationId = await resolveCurrentInstallationId({
    stateDir,
    createIfMissing: false,
  });
  if (!installationId) {
    const empty = { installationId: undefined, snapshots: [] };
    runtime.log(opts.json ? JSON.stringify(empty, null, 2) : "No backup installation id found.");
    return empty;
  }

  const storage = await resolveSnapshotListStore({ snapshotStore, deps });
  const snapshots = (await storage.listSnapshots({ installationId }))
    .map(toSnapshotListEntry)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));

  const result: BackupListResult = { installationId, snapshots };
  runtime.log(
    opts.json
      ? JSON.stringify(result, null, 2)
      : snapshots.length === 0
        ? `No backup snapshots found for installation ${installationId}`
        : [
            `Backup snapshots for ${installationId}:`,
            ...snapshots.map(
              (entry) =>
                `- ${entry.snapshotId} ${entry.createdAt} ${entry.mode} bytes=${entry.ciphertextBytes}`,
            ),
          ].join("\n"),
  );
  return result;
}
