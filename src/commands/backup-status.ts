import { readConfigFileSnapshot } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import {
  loadResolvedSnapshotBackup,
  resolveSnapshotStore,
  resolveCurrentInstallationId,
  toSnapshotListEntry,
  type BackupSnapshotDeps,
} from "./backup-snapshot-shared.js";
import { getWorkspaceBackupStatus, type WorkspaceBackupStatusResult } from "./workspace-backup.js";

export type BackupStatusOptions = {
  json?: boolean;
};

export type BackupStatusResult = {
  target?: string;
  workspace: WorkspaceBackupStatusResult;
  snapshot: {
    enabled: boolean;
    installationId?: string;
    snapshotCount: number;
    latestSnapshotId?: string;
    latestSnapshotAt?: string;
    error?: string;
  };
};

async function getSnapshotStatus(
  deps?: BackupSnapshotDeps,
): Promise<BackupStatusResult["snapshot"] & { target?: string }> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    throw new Error("Config is invalid. Backup commands require a valid config file.");
  }

  const target = snapshot.config.backup?.target?.trim() || undefined;
  const enabled = Boolean(target && snapshot.config.backup?.encryption?.key);
  if (!enabled) {
    return {
      enabled: false,
      snapshotCount: 0,
      target,
    };
  }

  try {
    const resolved = await loadResolvedSnapshotBackup({});
    const installationId = await resolveCurrentInstallationId({
      stateDir: resolved.stateDir,
      createIfMissing: false,
    });
    if (!installationId) {
      return {
        enabled: true,
        snapshotCount: 0,
        target: resolved.snapshotStore.targetDir,
      };
    }
    const storage = await resolveSnapshotStore({
      snapshotStore: resolved.snapshotStore,
      deps,
    });
    const entries = (await storage.listSnapshots({ installationId }))
      .map(toSnapshotListEntry)
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
    return {
      enabled: true,
      installationId,
      snapshotCount: entries.length,
      latestSnapshotId: entries[0]?.snapshotId,
      latestSnapshotAt: entries[0]?.createdAt,
      target: resolved.snapshotStore.targetDir,
    };
  } catch (error) {
    return {
      enabled: true,
      snapshotCount: 0,
      target,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatStatusMessage(result: BackupStatusResult): string {
  const lines = [
    `Backup target: ${result.target ? shortenHomePath(result.target) : "not configured"}`,
    `Workspace backup: ${result.workspace.configured ? "configured" : "not configured"}`,
    `Workspace last updated: ${result.workspace.lastUpdatedAt ?? "never"}`,
    `Mirrored workspaces: ${result.workspace.workspaceCount}`,
    `Full backup: ${result.snapshot.enabled ? "enabled" : "not enabled"}`,
  ];

  if (result.snapshot.installationId) {
    lines.push(`Installation id: ${result.snapshot.installationId}`);
  }
  if (result.snapshot.latestSnapshotId && result.snapshot.latestSnapshotAt) {
    lines.push(
      `Latest snapshot: ${result.snapshot.latestSnapshotId} ${result.snapshot.latestSnapshotAt}`,
    );
  } else {
    lines.push("Latest snapshot: none");
  }
  lines.push(`Snapshot count: ${result.snapshot.snapshotCount}`);
  if (result.snapshot.error) {
    lines.push(`Snapshot status warning: ${result.snapshot.error}`);
  }
  return lines.join("\n");
}

export async function backupStatusCommand(
  runtime: RuntimeEnv,
  opts: BackupStatusOptions,
  deps?: BackupSnapshotDeps,
): Promise<BackupStatusResult> {
  const workspace = await getWorkspaceBackupStatus();
  const snapshot = await getSnapshotStatus(deps);
  const result: BackupStatusResult = {
    target: workspace.target ?? snapshot.target,
    workspace,
    snapshot,
  };
  runtime.log(opts.json ? JSON.stringify(result, null, 2) : formatStatusMessage(result));
  return result;
}
