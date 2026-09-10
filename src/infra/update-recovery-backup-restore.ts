import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { UpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import { pinDirectory, requireDirectorySync, syncDirectory } from "./directory-durability.js";
import { root as safeRoot } from "./fs-safe.js";
import {
  openNodeSqliteDatabase,
  requireNodeSqlite,
  resolveSqliteFilesystemPath,
} from "./node-sqlite.js";
import { SQLITE_SIDECAR_SUFFIXES } from "./sqlite-files.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import { fileDigest, statOrMissing } from "./update-recovery-backup-files.js";
import { captureUpdateRecoveryConfigRestore } from "./update-recovery-config-writes.js";

export async function restorePreparedUpdateRecoveryBackup(
  prepared: {
    manifest: UpdateRecoveryBackupManifest;
    payloads: ReadonlyMap<string, string>;
    assertCurrent: () => Promise<void>;
  },
  authority: { assertOwned: () => void },
): Promise<void> {
  const { manifest, payloads } = prepared;
  const mutate = async <T>(operation: () => Promise<T>): Promise<T> => {
    await prepared.assertCurrent();
    authority.assertOwned();
    return await operation();
  };
  const capturedPaths = new Set([
    ...manifest.entries.map((entry) => entry.sourcePath),
    // Online restore owns these sidecars; an older updater can still hold them open.
    ...manifest.entries.flatMap((entry) =>
      entry.kind === "file" && entry.sqlite
        ? SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${entry.sourcePath}${suffix}`)
        : [],
    ),
    ...manifest.excludedRoots,
  ]);
  const pruneDirectory = async (pathname: string): Promise<void> => {
    const pin = await pinDirectory(pathname);
    try {
      if (pin.receipt.realPath !== pathname) {
        throw new Error(`Update recovery directory changed location: ${pathname}`);
      }
      const directory = await safeRoot(pathname);
      const remove = async (relativePath: string, isDirectory: boolean): Promise<void> => {
        if (isDirectory) {
          for (const child of await directory.list(relativePath, { withFileTypes: true })) {
            await remove(path.join(relativePath, child.name), child.isDirectory);
          }
        }
        await mutate(async () => {
          await pin.assertCurrent();
          authority.assertOwned();
          await directory.remove(relativePath);
        });
      };
      for (const child of await directory.list("", { withFileTypes: true })) {
        if (!capturedPaths.has(path.join(pathname, child.name))) {
          await remove(child.name, child.isDirectory);
        }
      }
      requireDirectorySync(await pin.sync(), "Update recovery directory");
    } finally {
      await pin.close();
    }
  };
  const sqlitePaths = manifest.entries.flatMap((entry) =>
    (entry.kind === "file" || entry.kind === "missing") && entry.sqlite ? [entry.sourcePath] : [],
  );
  // Agent drains release leases through shared state; finish every drain first.
  for (const pathname of sqlitePaths) {
    await prepared.assertCurrent();
    authority.assertOwned();
    await closeOpenClawAgentDatabasesAsync(pathname);
  }
  for (const pathname of sqlitePaths) {
    await prepared.assertCurrent();
    authority.assertOwned();
    closeOpenClawStateDatabaseByPath(pathname);
  }
  const configLink = (entry: UpdateRecoveryBackupManifest["entries"][number]) =>
    Number(entry.kind === "symlink" && manifest.configPaths.includes(entry.sourcePath));
  for (const entry of manifest.entries.toSorted(
    (a, b) => configLink(a) - configLink(b) || a.sourcePath.length - b.sourcePath.length,
  )) {
    await prepared.assertCurrent();
    authority.assertOwned();
    if (entry.kind === "missing") {
      const current = await statOrMissing(entry.sourcePath);
      if (current?.isDirectory()) {
        // Only a migration-owned directory declaration grants recursive removal.
        if (entry.directory) {
          await mutate(() => fs.rm(entry.sourcePath, { recursive: true }));
        }
      } else if (current) {
        await captureUpdateRecoveryConfigRestore(
          manifest,
          entry.sourcePath,
          () => mutate(() => fs.unlink(entry.sourcePath)),
          "absent",
        );
      }
      if (entry.sqlite) {
        for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
          await mutate(() => fs.rm(`${entry.sourcePath}${suffix}`, { force: true }));
        }
      }
      continue;
    }
    const current = await statOrMissing(entry.sourcePath);
    if (entry.kind === "directory") {
      if (current && !current.isDirectory()) {
        await mutate(() => fs.unlink(entry.sourcePath));
      }
      await mutate(() => fs.mkdir(entry.sourcePath, { recursive: true, mode: entry.mode }));
      await mutate(() => fs.chmod(entry.sourcePath, entry.mode));
      // Directory entries belong only to declared migration resources.
      await pruneDirectory(entry.sourcePath);
      continue;
    }
    await mutate(() => fs.mkdir(path.dirname(entry.sourcePath), { recursive: true, mode: 0o700 }));
    if (current?.isDirectory()) {
      throw new Error(
        `Update recovery destination contains newer directory state: ${entry.sourcePath}`,
      );
    }
    if (entry.kind === "symlink") {
      if (current) {
        await captureUpdateRecoveryConfigRestore(
          manifest,
          entry.sourcePath,
          () => mutate(() => fs.unlink(entry.sourcePath)),
          "absent",
        );
      }
      await captureUpdateRecoveryConfigRestore(manifest, entry.sourcePath, () =>
        mutate(() => fs.symlink(entry.target, entry.sourcePath)),
      );
      continue;
    }
    const verifiedSource = payloads.get(entry.archivePath);
    if (!verifiedSource) {
      throw new Error(`Update recovery payload was not staged: ${entry.archivePath}`);
    }
    const temporary = `${entry.sourcePath}.update-recovery-${randomUUID()}`;
    try {
      if (entry.sqlite) {
        // An older updater keeps its connection open. Restore through SQLite so
        // that connection observes the reverted pages in the same inode and WAL.
        if (current?.isSymbolicLink()) {
          await mutate(() => fs.unlink(entry.sourcePath));
        }
        const source = openNodeSqliteDatabase(verifiedSource, { readOnly: true });
        try {
          await mutate(() =>
            requireNodeSqlite().backup(source, resolveSqliteFilesystemPath(entry.sourcePath), {
              progress: authority.assertOwned,
            }),
          );
        } finally {
          source.close();
        }
        await mutate(() => fs.chmod(entry.sourcePath, entry.mode));
        await createVerifiedSqliteSnapshot({
          sourcePath: entry.sourcePath,
          targetPath: temporary,
          preserveRowIds: true,
          beforePublish: authority.assertOwned,
        });
      } else {
        await fs.copyFile(verifiedSource, temporary, fs.constants.COPYFILE_EXCL);
        await fs.chmod(temporary, entry.mode);
        const target = await fs.open(temporary, "r+");
        try {
          await target.sync();
        } finally {
          await target.close();
        }
      }
      const actual = await fileDigest(temporary);
      if (actual.sha256 !== entry.sha256 || actual.size !== entry.size) {
        throw new Error(`Restored update recovery file failed verification: ${entry.sourcePath}`);
      }
      if (!entry.sqlite) {
        await captureUpdateRecoveryConfigRestore(manifest, entry.sourcePath, () =>
          mutate(() => fs.rename(temporary, entry.sourcePath)),
        );
      }
      requireDirectorySync(
        await syncDirectory(path.dirname(entry.sourcePath)),
        "Update recovery destination",
      );
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  authority.assertOwned();
}
