// Rotates config backup files while preserving recent recovery points.
import path from "node:path";
import { captureConfigWriteLockGuard } from "./write-lock.js";

const CONFIG_BACKUP_COUNT = 5;

interface BackupRotationFs {
  unlink: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  chmod?: (path: string, mode: number) => Promise<void>;
}

interface BackupMaintenanceFs extends BackupRotationFs {
  copyFile: (from: string, to: string) => Promise<void>;
}

/**
 * Advances the config `.bak` ring before a new primary backup is copied in.
 *
 * Missing slots are ignored so interrupted writes or first-run configs do not
 * block the next config write.
 */
async function rotateConfigBackups(
  configPath: string,
  ioFs: BackupRotationFs,
  assertCurrent: () => void,
): Promise<void> {
  if (CONFIG_BACKUP_COUNT <= 1) {
    return;
  }
  const backupBase = `${configPath}.bak`;
  const maxIndex = CONFIG_BACKUP_COUNT - 1;
  assertCurrent();
  await ioFs.unlink(`${backupBase}.${maxIndex}`).catch(() => {
    assertCurrent();
    // best-effort
  });
  for (let index = maxIndex - 1; index >= 1; index -= 1) {
    assertCurrent();
    await ioFs.rename(`${backupBase}.${index}`, `${backupBase}.${index + 1}`).catch(() => {
      assertCurrent();
      // best-effort
    });
  }
  assertCurrent();
  await ioFs.rename(backupBase, `${backupBase}.1`).catch(() => {
    assertCurrent();
    // best-effort
  });
}

/**
 * Sets owner-only permissions on every backup slot when chmod exists.
 *
 * Backups are copied on mixed filesystems, so copy mode preservation is not a
 * portable security guarantee.
 */
async function hardenBackupPermissions(
  configPath: string,
  ioFs: BackupRotationFs,
  assertCurrent: () => void,
): Promise<void> {
  if (!ioFs.chmod) {
    return;
  }
  const backupBase = `${configPath}.bak`;
  assertCurrent();
  await ioFs.chmod(backupBase, 0o600).catch(() => {
    assertCurrent();
    // best-effort
  });
  for (let i = 1; i < CONFIG_BACKUP_COUNT; i++) {
    assertCurrent();
    await ioFs.chmod(`${backupBase}.${i}`, 0o600).catch(() => {
      assertCurrent();
      // best-effort
    });
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
  ioFs: BackupMaintenanceFs,
  assertConfigPathForWrite?: () => void,
): Promise<void> {
  const sourceGuard = captureConfigWriteLockGuard(configPath);
  const assertCurrent = () => {
    sourceGuard?.();
    assertConfigPathForWrite?.();
  };
  await rotateConfigBackups(configPath, ioFs, assertCurrent);
  assertCurrent();
  await ioFs.copyFile(configPath, `${configPath}.bak`).catch(() => {
    assertCurrent();
    // best-effort
  });
  await hardenBackupPermissions(configPath, ioFs, assertCurrent);
}
