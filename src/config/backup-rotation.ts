// Config publication stages candidates before consuming recovery history.
import { randomUUID } from "node:crypto";
import type fs from "node:fs";
import path from "node:path";
import { tempFile } from "@openclaw/fs-safe/advanced";
import { replaceFileAtomicSync, type ReplaceFileAtomicSyncOptions } from "@openclaw/fs-safe/atomic";
import { isRootFileMissingFailure, openRootFileSync } from "../infra/boundary-file-read.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import { createConfigWriteAuthorityGuard } from "./write-authority.js";

export const CONFIG_BACKUP_COUNT = 5;

/** Prepare backup bytes without blocking unrelated Gateway requests. */
export async function prepareConfigFileWrite(
  params: {
    configPath: string;
    content: string;
    previousRaw: string | null;
    warn?: (message: string) => void;
    fsModule: typeof fs;
    assertCurrent?: () => void;
    destinationHardlinks?: "reject";
    durable?: boolean;
  } & Pick<ReplaceFileAtomicSyncOptions, "assertBeforeMutation" | "onDestinationState" | "dirMode">,
) {
  const { configPath, fsModule } = params;
  const assertCurrent = createConfigWriteAuthorityGuard(params.assertCurrent);
  const assertBeforeMutation = createConfigWriteAuthorityGuard(
    params.assertBeforeMutation ?? assertCurrent,
  );
  let backupRotationWarningIssued = false;
  const warnBackupRotationFailure = () => {
    if (backupRotationWarningIssued) {
      return;
    }
    backupRotationWarningIssued = true;
    try {
      params.warn?.(
        "Config backup rotation failed; the config write is continuing without a guaranteed current backup. Before making further config changes, create and verify a backup with `openclaw backup create --verify`.",
      );
    } catch {
      // Logging must not turn best-effort backup maintenance into a failed config write.
    }
  };
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
  } catch (error) {
    try {
      await backup?.[Symbol.asyncDispose]();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Config backup preparation and cleanup failed",
        { cause: cleanupError },
      );
    }
    backup = undefined;
    // Backup creation remains best effort; failed preparation never consumes history.
    assertCurrent?.();
    warnBackupRotationFailure();
  }
  return {
    publish() {
      return replaceFileAtomicSync({
        filePath: configPath,
        content: params.content,
        dirMode: params.dirMode ?? 0o700,
        mode: 0o600,
        copyFallbackOnPermissionError: true,
        destinationHardlinks: params.destinationHardlinks,
        syncTempFile: params.durable,
        syncParentDir: params.durable,
        fileSystem: fsModule,
        throwOnCleanupError: true,
        assertBeforeMutation,
        onDestinationState: params.onDestinationState,
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
          const captureBackupIdentity = (
            filePath: string,
            fd: number | undefined,
            role: "source" | "destination",
          ) => {
            const captured =
              fd === undefined ? undefined : fsModule.fstatSync(fd, { bigint: true });
            return () => {
              const current = fsModule.lstatSync(filePath, {
                bigint: true,
                throwIfNoEntry: role === "source",
              });
              const held = fd === undefined ? undefined : fsModule.fstatSync(fd, { bigint: true });
              if (
                captured
                  ? [current, held].some(
                      (entry) =>
                        !entry ||
                        !entry.isFile() ||
                        entry.nlink !== 1n ||
                        entry.dev !== captured.dev ||
                        entry.ino !== captured.ino,
                    )
                  : current
              ) {
                throw new ConfigMutationConflictError(`config backup ${role} changed`, {
                  retryable: false,
                });
              }
            };
          };
          const mutateBackupArtifact = (from: string, to?: string) => {
            assertBeforeMutation();
            try {
              using destination = to ? openBackupArtifact(to) : undefined;
              if (destination && !destination.ok && !isRootFileMissingFailure(destination)) {
                warnBackupRotationFailure();
                return;
              }
              using source = openBackupArtifact(from);
              if (!source.ok) {
                if (!isRootFileMissingFailure(source)) {
                  warnBackupRotationFailure();
                }
                return;
              }
              const assertSource = captureBackupIdentity(source.path, source.fd, "source");
              const assertDestination = to
                ? captureBackupIdentity(
                    to,
                    destination?.ok ? destination.fd : undefined,
                    "destination",
                  )
                : undefined;
              const assertBackupCurrent = () => {
                assertBeforeMutation();
                assertSource();
                assertDestination?.();
              };
              assertBackupCurrent();
              if (to) {
                fsModule.fchmodSync(source.fd, 0o600);
                assertBackupCurrent();
                fsModule.renameSync(source.path, to);
              } else {
                fsModule.unlinkSync(source.path);
              }
            } catch (error) {
              assertBeforeMutation();
              if (error instanceof ConfigMutationConflictError) {
                throw error;
              }
              warnBackupRotationFailure();
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
    options: { encoding: "utf-8"; mode: number; flag: "wx" },
  ) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  rm: (path: string) => Promise<void>;
  readFile: (path: string, encoding: "utf-8") => Promise<string>;
  existsSync: (path: string) => boolean;
}

const preUpdateConfigSnapshotsWritten = new Set<string>();

/**
 * Captures the first on-disk config state for an update attempt.
 *
 * The snapshot is outside the rotating `.bak` ring so repeated writes during
 * one process keep an operator-visible rollback point for the original file.
 * It publishes through a same-directory rename so a crash mid-write cannot
 * truncate the previous rollback point.
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
  const tempPath = `${snapshotPath}.${randomUUID()}.tmp`;
  try {
    const content = await params.fs.readFile(params.configPath, "utf-8");
    await params.fs.writeFile(tempPath, content, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    await params.fs.rename(tempPath, snapshotPath);
  } catch {
    // Best-effort: let the update continue, but allow its later snapshot pass to retry.
    try {
      await params.fs.rm(tempPath);
    } catch {
      // The temp file may not exist yet; the marker reset below still allows a retry.
    }
    preUpdateConfigSnapshotsWritten.delete(snapshotKey);
  }
}
