// Rotates config backup files while preserving recent recovery points.
import type fs from "node:fs";
import path from "node:path";
import { captureConfigWriteLockGuard } from "./write-lock.js";

const CONFIG_BACKUP_COUNT = 5;

interface BackupMaintenanceFs<T> {
  unlink: (path: string) => T;
  rename: (from: string, to: string) => T;
  chmod?: (path: string, mode: number) => T;
  copyFile: (from: string, to: string) => T;
}

/** One operation order for asynchronous include adapters and synchronous root publication. */
function* configBackupOperations<T>(configPath: string, ioFs: BackupMaintenanceFs<T>) {
  const backupBase = `${configPath}.bak`;
  yield () => ioFs.unlink(`${backupBase}.${CONFIG_BACKUP_COUNT - 1}`);
  for (let index = CONFIG_BACKUP_COUNT - 2; index >= 0; index--) {
    const from = index === 0 ? backupBase : `${backupBase}.${index}`;
    yield () => ioFs.rename(from, `${backupBase}.${index + 1}`);
  }
  yield () => ioFs.copyFile(configPath, backupBase);
  if (ioFs.chmod) {
    const chmod = ioFs.chmod;
    for (let index = 0; index < CONFIG_BACKUP_COUNT; index++) {
      yield () => chmod(index === 0 ? backupBase : `${backupBase}.${index}`, 0o600);
    }
  }
}

interface PreUpdateSnapshotFs {
  writeFile: (
    path: string,
    content: string,
    options: { encoding: "utf-8"; mode: number; flag: "w" },
  ) => Promise<void>;
  readFile: (path: string, encoding: "utf-8") => Promise<string>;
  existsSync: (path: string) => boolean;
}

const preUpdateConfigSnapshotsWritten = new Set<string>();

/**
 * Captures the first on-disk config state for an update attempt.
 *
 * The snapshot is outside the rotating `.bak` ring so repeated writes during
 * one process keep an operator-visible rollback point for the original file.
 */
export async function createPreUpdateConfigSnapshot(params: {
  configPath: string;
  fs: PreUpdateSnapshotFs;
}): Promise<void> {
  if (!params.fs.existsSync(params.configPath)) {
    return;
  }
  const snapshotKey = path.resolve(params.configPath);
  if (preUpdateConfigSnapshotsWritten.has(snapshotKey)) {
    return;
  }
  // Mark before I/O so concurrent callers coalesce onto the in-flight snapshot attempt.
  preUpdateConfigSnapshotsWritten.add(snapshotKey);
  const snapshotPath = `${params.configPath}.pre-update`;
  try {
    const content = await params.fs.readFile(params.configPath, "utf-8");
    await params.fs.writeFile(snapshotPath, content, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "w",
    });
  } catch {
    // Best-effort: let the update continue, but allow its later snapshot pass to retry.
    preUpdateConfigSnapshotsWritten.delete(snapshotKey);
  }
}

/** Runs rotation, primary copy, and permission hardening. */
export async function maintainConfigBackups(
  configPath: string,
  ioFs: BackupMaintenanceFs<Promise<void>>,
  assertConfigPathForWrite?: () => void,
): Promise<void> {
  const sourceGuard = captureConfigWriteLockGuard(configPath);
  const assertCurrent = () => {
    sourceGuard?.();
    assertConfigPathForWrite?.();
  };
  for (const operation of configBackupOperations(configPath, ioFs)) {
    assertCurrent();
    await operation().catch(() => {
      // Missing slots and backup I/O failures remain best effort.
      assertCurrent();
    });
  }
}

export function maintainConfigBackupsSync(
  configPath: string,
  ioFs: typeof fs,
  assertCurrent?: () => void,
): void {
  for (const operation of configBackupOperations(configPath, {
    unlink: ioFs.unlinkSync,
    rename: ioFs.renameSync,
    copyFile: ioFs.copyFileSync,
    chmod: ioFs.chmodSync,
  })) {
    assertCurrent?.();
    try {
      operation();
    } catch {
      // Match asynchronous backup maintenance without yielding during publication.
      assertCurrent?.();
    }
  }
}
