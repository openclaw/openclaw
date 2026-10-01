import fs from "node:fs";
import path from "node:path";
import { root } from "@openclaw/fs-safe/root";
import { requireDirectorySync, syncDirectory } from "./directory-durability.js";
import { resolveLegacyMigrationSourcePath } from "./state-migrations.source-path.js";
import {
  assertLegacyMigrationSourceUnchanged,
  claimAndRemoveLegacyMigrationSource,
  LegacyMigrationSourceClaim,
  legacyMigrationSourceSnapshotsMatch,
  readLegacyMigrationSourceSnapshot,
  readLegacyMigrationSourceSnapshotSync,
  type LegacyMigrationSourceSnapshot,
} from "./state-migrations.source-snapshot.js";

/** Resume the existing claim protocol without changing the original receipt identity. */
export async function recoverLegacyStateSource(params: {
  filePath: string;
  claimPaths?: readonly string[];
  assertCurrent: () => void;
}): Promise<void> {
  params.assertCurrent();
  if (!params.claimPaths?.length) {
    return;
  }
  const directory = path.dirname(params.filePath);
  const sourceRoot = await root(directory, {
    hardlinks: "reject",
    symlinks: "reject",
    mkdir: false,
    assertBeforeMutation: params.assertCurrent,
  });
  for (const claimPath of params.claimPaths) {
    if (
      claimPath === params.filePath ||
      resolveLegacyMigrationSourcePath(claimPath) !== params.filePath
    ) {
      throw new Error(`Invalid legacy migration claim for ${params.filePath}`);
    }
    params.assertCurrent();
    const claim = new LegacyMigrationSourceClaim({
      stateRoot: sourceRoot,
      stateDir: directory,
      sourcePath: params.filePath,
      label: "state migration",
      claimSuffix: claimPath.slice(params.filePath.length),
      readSnapshot: (sourcePath) =>
        readLegacyMigrationSourceSnapshot({
          stateRoot: sourceRoot,
          stateDir: directory,
          sourcePath,
          maxBytes: Number.MAX_SAFE_INTEGER,
          label: "state migration",
        }),
    });
    await claim.recover(
      `Legacy migration source and interrupted claim disagree: ${params.filePath}`,
    );
  }
}

/** Preserve exact source bytes before parsing or normalizing any durable legacy row. */
export async function backupLegacyStateSource(params: {
  filePath: string;
  claimPaths?: readonly string[];
  expectedSnapshot?: LegacyMigrationSourceSnapshot;
  assertCurrent: () => void;
}): Promise<{
  bytes: Buffer;
  snapshot: LegacyMigrationSourceSnapshot;
  backupPath: string;
  assertUnchanged: () => void;
  assertBackupUnchanged: () => void;
  removeSource: (markSourceRemoved: () => undefined) => void;
}> {
  await recoverLegacyStateSource(params);
  params.assertCurrent();
  const directory = path.dirname(params.filePath);
  const sourceRoot = await root(directory, {
    hardlinks: "reject",
    symlinks: "reject",
    mkdir: false,
    mode: 0o600,
    assertBeforeMutation: params.assertCurrent,
  });
  const snapshot = await readLegacyMigrationSourceSnapshot({
    stateRoot: sourceRoot,
    stateDir: directory,
    sourcePath: params.filePath,
    maxBytes: Number.MAX_SAFE_INTEGER,
    label: "state migration",
  });
  if (
    params.expectedSnapshot &&
    !legacyMigrationSourceSnapshotsMatch(snapshot, params.expectedSnapshot)
  ) {
    throw new Error(`Legacy migration source changed before backup: ${params.filePath}`);
  }
  const assertUnchanged = () => {
    params.assertCurrent();
    assertLegacyMigrationSourceUnchanged({
      sourcePath: params.filePath,
      snapshot,
      label: "state migration",
    });
  };
  let backupName = `${path.basename(params.filePath)}.migrated`;
  for (let index = 2; await sourceRoot.exists(backupName); index++) {
    const existing = await sourceRoot.read(backupName, { maxBytes: Number.MAX_SAFE_INTEGER });
    if (existing.buffer.equals(snapshot.buffer)) {
      break;
    }
    backupName = `${path.basename(params.filePath)}.migrated.${index}`;
  }
  if (!(await sourceRoot.exists(backupName))) {
    assertUnchanged();
    await sourceRoot.create(backupName, snapshot.buffer, { mode: 0o600 });
  }
  const backup = await sourceRoot.read(backupName, { maxBytes: Number.MAX_SAFE_INTEGER });
  if (!backup.buffer.equals(snapshot.buffer)) {
    throw new Error(`Legacy migration backup differs from its source: ${backupName}`);
  }
  {
    await using opened = await sourceRoot.open(backupName);
    params.assertCurrent();
    await opened.handle.sync();
  }
  params.assertCurrent();
  requireDirectorySync(await syncDirectory(directory), "Legacy migration backup directory");
  assertUnchanged();
  const backupPath = path.join(directory, backupName);
  const backupIdentity = {
    dev: backup.stat.dev,
    ino: backup.stat.ino,
    mtimeMs: backup.stat.mtimeMs,
    sha256: snapshot.sha256,
    size: snapshot.size,
  };
  const assertBackupUnchanged = () => {
    params.assertCurrent();
    const retained = readLegacyMigrationSourceSnapshotSync({
      sourcePath: backupPath,
      label: "state migration backup",
      maxBytes: snapshot.size,
    });
    if (!legacyMigrationSourceSnapshotsMatch(retained, backupIdentity)) {
      throw new Error(`Legacy migration backup changed before source removal: ${backupPath}`);
    }
  };
  assertBackupUnchanged();
  return {
    bytes: snapshot.buffer,
    snapshot,
    backupPath,
    assertUnchanged,
    assertBackupUnchanged,
    removeSource: (markSourceRemoved) =>
      claimAndRemoveLegacyMigrationSource({
        sourcePath: params.filePath,
        snapshot,
        label: "state migration",
        beforeClaim: () => {
          assertUnchanged();
          assertBackupUnchanged();
        },
        beforeRestore: params.assertCurrent,
        removeSource: (claimPath) => {
          // The claim remains discoverable until receipt bookkeeping commits.
          markSourceRemoved();
          assertBackupUnchanged();
          assertLegacyMigrationSourceUnchanged({
            sourcePath: claimPath,
            snapshot,
            label: "state migration",
          });
          params.assertCurrent();
          fs.unlinkSync(claimPath);
        },
      }),
  };
}
