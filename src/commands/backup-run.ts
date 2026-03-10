import { readConfigFileSnapshot } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { backupPushCommand, type BackupPushOptions, type BackupPushResult } from "./backup-push.js";
import type { BackupSnapshotDeps } from "./backup-snapshot-shared.js";
import {
  workspaceBackupRunCommand,
  type WorkspaceBackupRunOptions,
  type WorkspaceBackupRunResult,
} from "./workspace-backup.js";

export type BackupRunMode = "auto" | "snapshot";

export type BackupRunOptions = BackupPushOptions &
  WorkspaceBackupRunOptions & {
    mode?: BackupRunMode;
  };

export type BackupRunResult =
  | {
      kind: "snapshot";
      snapshot: BackupPushResult;
    }
  | {
      kind: "workspace";
      workspace: WorkspaceBackupRunResult;
    };

function hasSnapshotBackupConfigured(): Promise<boolean> {
  return readConfigFileSnapshot().then((snapshot) => {
    if (!snapshot.valid) {
      throw new Error("Config is invalid. Backup commands require a valid config file.");
    }
    return Boolean(
      snapshot.config.backup?.target?.trim() && snapshot.config.backup?.encryption?.key,
    );
  });
}

export async function backupRunCommand(
  runtime: RuntimeEnv,
  opts: BackupRunOptions,
  deps?: BackupSnapshotDeps,
): Promise<BackupRunResult> {
  const mode = opts.mode ?? "auto";
  const shouldRunSnapshot =
    mode === "snapshot" || (mode === "auto" && (await hasSnapshotBackupConfigured()));

  if (!shouldRunSnapshot) {
    if (opts.output || opts.verify || opts.snapshotName) {
      throw new Error(
        "Snapshot-only options are not supported when backup run falls back to workspace mirroring.",
      );
    }
    return {
      kind: "workspace",
      workspace: await workspaceBackupRunCommand(runtime, {
        json: opts.json,
      }),
    };
  }
  return {
    kind: "snapshot",
    snapshot: await backupPushCommand(
      runtime,
      {
        output: opts.output,
        json: opts.json,
        verify: opts.verify,
        snapshotName: opts.snapshotName,
      },
      deps,
    ),
  };
}
