// Config publication stages candidates before consuming recovery history.
import type fs from "node:fs";
import path from "node:path";
import { isRootFileMissingFailure, openRootFileSync } from "../infra/boundary-file-read.js";
import { tempFile } from "../infra/fs-safe-advanced.js";
import { replaceFileAtomicSync } from "../infra/replace-file.js";

const CONFIG_BACKUP_COUNT = 5;

/** Prepare backup bytes without blocking unrelated Gateway requests. */
export async function prepareConfigFileWrite(params: {
  configPath: string;
  content: string;
  previousRaw: string | null;
  fsModule: typeof fs;
  assertCurrent?: () => void;
  destinationHardlinks?: "reject";
  durable?: boolean;
}) {
  const { configPath, fsModule, assertCurrent } = params;
  assertCurrent?.();
  let backup: Awaited<ReturnType<typeof tempFile>> | undefined;
  try {
    if (params.previousRaw !== null) {
      backup = await tempFile({
        rootDir: path.dirname(configPath),
        prefix: "openclaw-config-backup",
        fileName: "original",
      });
      assertCurrent?.();
      await using handle = await fsModule.promises.open(backup.path, "wx", 0o600);
      assertCurrent?.();
      await handle.writeFile(params.previousRaw, "utf8");
      assertCurrent?.();
      if (params.durable) {
        await handle.sync();
        assertCurrent?.();
      }
    }
  } catch {
    await backup?.[Symbol.asyncDispose]();
    backup = undefined;
    // Backup creation remains best effort; failed preparation never consumes history.
    assertCurrent?.();
  }
  return {
    publish() {
      return replaceFileAtomicSync({
        filePath: configPath,
        content: params.content,
        dirMode: 0o700,
        mode: 0o600,
        copyFallbackOnPermissionError: true,
        destinationHardlinks: params.destinationHardlinks,
        syncTempFile: params.durable,
        syncParentDir: params.durable,
        fileSystem: fsModule,
        beforeRename: () => {
          if (!backup) {
            return;
          }
          const openBackupArtifact = (absolutePath: string) => {
            const opened = openRootFileSync({
              absolutePath,
              rootPath: path.dirname(configPath),
              boundaryLabel: "config backup directory",
              ioFs: fsModule,
            });
            return {
              ...opened,
              [Symbol.dispose]() {
                if (opened.ok) {
                  fsModule.closeSync(opened.fd);
                }
              },
            };
          };
          const mutateBackupArtifact = (from: string, to?: string) => {
            assertCurrent?.();
            try {
              using destination = to ? openBackupArtifact(to) : undefined;
              if (destination && !destination.ok && !isRootFileMissingFailure(destination)) {
                return;
              }
              using source = openBackupArtifact(from);
              if (!source.ok) {
                return;
              }
              assertCurrent?.();
              if (to) {
                fsModule.fchmodSync(source.fd, 0o600);
                assertCurrent?.();
                fsModule.renameSync(source.path, to);
              } else {
                fsModule.unlinkSync(source.path);
              }
            } catch {
              assertCurrent?.();
            }
          };
          const base = `${configPath}.bak`;
          mutateBackupArtifact(`${base}.${CONFIG_BACKUP_COUNT - 1}`);
          for (let index = CONFIG_BACKUP_COUNT - 2; index >= 0; index--) {
            const from = index === 0 ? base : `${base}.${index}`;
            mutateBackupArtifact(from, `${base}.${index + 1}`);
          }
          mutateBackupArtifact(backup.path, base);
        },
      });
    },
    async [Symbol.asyncDispose]() {
      await backup?.[Symbol.asyncDispose]();
    },
  };
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
