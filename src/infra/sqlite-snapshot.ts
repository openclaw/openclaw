// Creates verified SQLite snapshots, compacting by default.
import { randomUUID } from "node:crypto";
import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { BackupProgressInfo, DatabaseSync } from "node:sqlite";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import {
  getPublishFileExclusiveFailureDetails,
  isHardlinkFallbackError,
  pinDirectory,
  publishFileExclusive,
  requireDirectorySync,
  sha256File,
  syncDirectory,
} from "./directory-durability.js";
import { formatErrorMessage } from "./errors.js";
import { sameFileMutationFingerprint, type FileMutationFingerprint } from "./file-descriptor.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { backupNodeSqliteDatabase } from "./sqlite-backup.js";
import { copySqliteFile } from "./sqlite-file-copy.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";
import { createPrivateSqliteTempDirectory } from "./sqlite-private-directory.js";
import { withPreparedSqliteSnapshot } from "./sqlite-readonly-location-cleanup.js";
import {
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyCopyInProcess,
} from "./sqlite-readonly-location.js";
import {
  assertExpectedContent,
  assertOpenFileIdentitySync,
  assertPublishedFileIdentitySync,
  hashPublishedFileSync,
  removePublicationStagingDirectory,
  removePublishedTargetIfOwned,
  sameFileStatFingerprint,
  type SqliteFileContent,
} from "./sqlite-snapshot-file.js";
import {
  prepareSqliteReadOnlyLocation,
  withSqliteSnapshotSource,
} from "./sqlite-snapshot-source.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";

export type SqliteSnapshotValidator = (database: DatabaseSync, databaseLabel: string) => void;

type CreateVerifiedSqliteSnapshotOptions = {
  sourcePath: string;
  targetPath: string;
  /** Only in an isolated child: acquire and consume a fresh private image, including crash recovery. */
  sourceAcquisition?: {
    mode: "isolated-process";
    stagingRoot: string;
    preserveSourceArtifacts?: boolean;
  };
  onProgress?: (progress: BackupProgressInfo) => void;
  /** Final caller checks around publication; failures remove only this helper's target. */
  afterPublish?: (guard: PublishedSqliteFileGuard) => void;
  beforePublish?: () => void | Promise<void>;
  requireNonEmptySource?: boolean;
  /** Skip compaction/ID rewriting; transforms may still change IDs and free-page data remains. */
  preserveRowIds?: boolean;
  transform?: (database: DatabaseSync) => void | Promise<void>;
  validate?: SqliteSnapshotValidator;
};

type PublishedSqliteFileGuard = {
  assertTargetMatchesExpectedContent: (finalCheck?: () => void) => void;
  assertTargetUnchanged: (finalCheck?: () => void) => void;
};

type PublishVerifiedSqliteFileOptions = {
  sourceIdentity: Stats;
  sourcePath: string;
  targetPath: string;
  expectedContent: SqliteFileContent;
  requireAtomicPublication?: boolean;
  beforePublish?: () => void | Promise<void>;
  validatePublished?: (publishedPath: string) => void | Promise<void>;
  /** Runs last. Call the supplied guard after any caller-specific checks. */
  afterPublish?: (guard: PublishedSqliteFileGuard) => void;
  /** Admit a destination byte copy only when actual native cloning is unavailable. */
  beforeByteCopy?: (sizeBytes: number) => void | Promise<void>;
};

type VerifiedSqliteSnapshot = SqliteFileContent & {
  path: string;
  userVersion: number;
};

async function assertRegularSourceFile(
  sourcePath: string,
  requireNonEmptySource: boolean,
): Promise<void> {
  const stat = await fs.lstat(sourcePath);
  if (!stat.isFile()) {
    throw new Error(`SQLite snapshot source must be a regular file: ${sourcePath}`);
  }
  if (requireNonEmptySource && stat.size === 0) {
    throw new Error(`SQLite snapshot source must not be empty: ${sourcePath}`);
  }
}

async function assertTargetAbsent(targetPath: string): Promise<void> {
  try {
    await fs.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`SQLite snapshot target already exists: ${targetPath}`);
}

async function copyFileExclusive(
  source: FileHandle,
  sourcePath: string,
  targetPath: string,
  beforeByteCopy?: PublishVerifiedSqliteFileOptions["beforeByteCopy"],
): Promise<{ content: SqliteFileContent; identity: BigIntStats }> {
  const sourceFingerprint = await source.stat({ bigint: true });
  let target: Awaited<ReturnType<typeof fs.open>> | undefined;
  let targetIdentity: BigIntStats | undefined;
  try {
    const publication = await copySqliteFile(
      sourcePath,
      targetPath,
      sourceFingerprint,
      beforeByteCopy,
    );
    target = await fs.open(targetPath, "r+");
    // Native receipts retain exact Windows file IDs beyond Number precision.
    const openedIdentity = await target.stat({ bigint: true });
    if (!sameFileIdentity(publication, openedIdentity)) {
      throw new Error(`SQLite snapshot target changed during publication: ${targetPath}`);
    }
    targetIdentity = openedIdentity;
    const content = await hashOpenPublishedFile(target, targetPath, targetIdentity);
    await assertMutationFingerprintUnchanged(source, sourceFingerprint, targetPath, content);
    await target.sync();
    const currentIdentity = await fs.lstat(targetPath, { bigint: true });
    if (!sameFileIdentity(targetIdentity, currentIdentity)) {
      throw new Error(`SQLite snapshot target changed during publication: ${targetPath}`);
    }
    return {
      content,
      identity: currentIdentity,
    };
  } catch (error) {
    if (targetIdentity) {
      await target?.close().catch(() => undefined);
      target = undefined;
      removePublishedTargetIfOwned(targetPath, targetIdentity);
    }
    throw error;
  } finally {
    await target?.close().catch(() => undefined);
  }
}

async function assertMutationFingerprintUnchanged(
  handle: FileHandle,
  expected: FileMutationFingerprint,
  filePath: string,
  expectedContent: SqliteFileContent,
): Promise<void> {
  const current = await handle.stat({ bigint: true });
  if (!sameFileMutationFingerprint(current, expected)) {
    if (!sameFileStatFingerprint(current, expected)) {
      throw new Error(`SQLite snapshot file changed while reading: ${filePath}`);
    }
    // Re-read the pinned snapshot when FUSE timestamps settle after copying or hashing.
    const { digest, bytes } = await sha256File(handle);
    assertExpectedContent({ sha256: digest, sizeBytes: bytes }, expectedContent, filePath);
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertOpenFileIdentity(
  handle: FileHandle,
  filePath: string,
  expectedIdentity: Stats | BigIntStats,
): Promise<void> {
  const options = { bigint: typeof expectedIdentity.ino === "bigint" };
  const openedIdentity = await handle.stat(options);
  const currentIdentity = await fs.lstat(filePath, options);
  if (
    !openedIdentity.isFile() ||
    !currentIdentity.isFile() ||
    !sameFileIdentity(expectedIdentity, openedIdentity) ||
    !sameFileIdentity(expectedIdentity, currentIdentity)
  ) {
    throw new Error(`SQLite snapshot file changed: ${filePath}`);
  }
}

async function hashPublishedFile(
  filePath: string,
  expectedIdentity: Stats | BigIntStats,
): Promise<SqliteFileContent> {
  const handle = await fs.open(filePath, "r");
  try {
    return await hashOpenPublishedFile(handle, filePath, expectedIdentity);
  } finally {
    await handle.close();
  }
}

async function hashOpenPublishedFile(
  handle: FileHandle,
  filePath: string,
  expectedIdentity: Stats | BigIntStats,
): Promise<SqliteFileContent> {
  await assertOpenFileIdentity(handle, filePath, expectedIdentity);
  const fingerprint = await handle.stat({ bigint: true });
  const { digest, bytes } = await sha256File(handle);
  const content = { sha256: digest, sizeBytes: bytes };
  await assertMutationFingerprintUnchanged(handle, fingerprint, filePath, content);
  await assertOpenFileIdentity(handle, filePath, expectedIdentity);
  return content;
}

function assertSynchronousCallbackResult(result: unknown, label: string): void {
  if (
    result &&
    (typeof result === "object" || typeof result === "function") &&
    typeof (result as { then?: unknown }).then === "function"
  ) {
    void Promise.resolve(result).catch(() => undefined);
    throw new Error(`${label} must be synchronous.`);
  }
}

/**
 * Publish the exact bytes of one already-verified SQLite file through a pinned
 * source identity. The target is always created exclusively.
 */
export async function publishVerifiedSqliteFile(
  options: PublishVerifiedSqliteFileOptions,
): Promise<void> {
  return publishSqliteFile(options, false);
}

/** Prepare an independent writable image beside its destination before replacing current state. */
export async function prepareVerifiedSqliteFile(options: PublishVerifiedSqliteFileOptions) {
  const directory = await createPrivateSqliteTempDirectory(
    path.dirname(options.targetPath),
    ".sqlite-publish-prepared-",
  );
  const directoryIdentity = await fs.lstat(directory);
  const sourcePath = path.join(directory, "database.sqlite");
  const cleanup = () => removePublicationStagingDirectory(directory, directoryIdentity);
  try {
    let sourceIdentity: Stats | undefined;
    await publishVerifiedSqliteFile({
      ...options,
      targetPath: sourcePath,
      afterPublish: (guard) => {
        assertSynchronousCallbackResult(
          options.afterPublish?.(guard),
          "SQLite after-publication guard",
        );
        sourceIdentity = fsSync.lstatSync(sourcePath);
        guard.assertTargetUnchanged();
      },
    });
    if (!sourceIdentity) {
      throw new Error(`SQLite prepared image was not published: ${sourcePath}`);
    }
    const preparedIdentity = sourceIdentity;
    return {
      path: sourcePath,
      cleanup,
      // The caller retains this image on publication failure. This path cannot
      // fall back to another image allocation after current state is displaced.
      publish: () =>
        publishSqliteFile({ ...options, sourcePath, sourceIdentity: preparedIdentity }, "prepared"),
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw createSqliteLifecycleAggregateError(
        [error, cleanupError],
        "SQLite output preparation and cleanup both failed",
        error,
      );
    }
    throw error;
  }
}

async function publishSqliteFile(
  options: PublishVerifiedSqliteFileOptions,
  consumeOwnedSource: boolean | "prepared",
): Promise<void> {
  await assertTargetAbsent(options.targetPath);
  const targetDirectory = path.resolve(path.dirname(options.targetPath));
  const targetDirectoryPin = await pinDirectory(targetDirectory, {
    label: "SQLite publication directory",
  });
  const targetDirectoryReceipt = targetDirectoryPin.receipt;
  let stagingDir: string;
  try {
    stagingDir =
      consumeOwnedSource === "prepared"
        ? path.dirname(options.sourcePath)
        : await createPrivateSqliteTempDirectory(
            targetDirectory,
            `.sqlite-publish-${randomUUID()}-`,
          );
  } catch (error) {
    await targetDirectoryPin.close().catch(() => undefined);
    throw error;
  }
  const stagedPath = path.join(stagingDir, "database.sqlite");
  let stagingIdentity: Stats | undefined;
  let source: FileHandle | undefined;
  let target: FileHandle | undefined;
  let targetPinFileDescriptor: number | undefined;
  let publishedIdentity: Stats | undefined;
  try {
    stagingIdentity = await fs.lstat(stagingDir);
    await fs.chmod(stagingDir, 0o700);
    source = await fs.open(options.sourcePath, "r");
    await assertOpenFileIdentity(source, options.sourcePath, options.sourceIdentity);
    // Snapshot creation owns this closed private image. Transfer that image into
    // publication custody instead of allocating another database-sized file.
    // Public callers retain their independently mutable source and still copy it.
    let staged: { content: SqliteFileContent; identity: Stats | BigIntStats };
    if (consumeOwnedSource === "prepared") {
      if (
        options.sourcePath !== stagedPath ||
        options.sourceIdentity.dev !== targetDirectoryReceipt.identity.dev
      ) {
        throw new Error(
          `SQLite prepared image is not on its publication volume: ${options.sourcePath}`,
        );
      }
      staged = {
        content: await hashOpenPublishedFile(source, options.sourcePath, options.sourceIdentity),
        identity: await source.stat({ bigint: true }),
      };
    } else if (
      consumeOwnedSource &&
      options.sourceIdentity.dev !== 0 &&
      options.sourceIdentity.ino !== 0 &&
      options.sourceIdentity.dev === stagingIdentity.dev
    ) {
      const moved = await publishFileExclusive({
        sourcePath: options.sourcePath,
        targetPath: stagedPath,
        expectedSourceIdentity: options.sourceIdentity,
        strategy: "link-or-copy",
      });
      requireDirectorySync(moved.directorySync, "SQLite staging transfer directory");
      const content = await hashPublishedFile(stagedPath, moved.identity);
      assertExpectedContent(content, options.expectedContent, stagedPath);
      // The shared publisher falls back to copying on filesystems without hard
      // links. Retire only our still-pinned source name, never a replacement.
      const opened = fsSync.fstatSync(source.fd, { bigint: true });
      const current = fsSync.lstatSync(options.sourcePath, { bigint: true });
      if (
        !current.isFile() ||
        opened.dev === 0n ||
        opened.ino === 0n ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino
      ) {
        throw new Error(`SQLite snapshot source changed during transfer: ${options.sourcePath}`);
      }
      fsSync.unlinkSync(options.sourcePath);
      const identity = await fs.lstat(stagedPath);
      if (!sameFileStatFingerprint(moved.identity, identity)) {
        throw new Error(`SQLite snapshot staging file changed during transfer: ${stagedPath}`);
      }
      staged = { content, identity };
    } else {
      staged = await copyFileExclusive(
        source,
        options.sourcePath,
        stagedPath,
        options.beforeByteCopy,
      );
    }
    const expectedContent = options.expectedContent;
    assertExpectedContent(staged.content, expectedContent, options.targetPath);
    await source.close();
    source = undefined;

    await options.validatePublished?.(stagedPath);
    const validatedContent = await hashPublishedFile(stagedPath, staged.identity);
    assertExpectedContent(validatedContent, expectedContent, options.targetPath);
    await options.beforePublish?.();
    await assertTargetAbsent(options.targetPath);
    const stagedStatOptions = { bigint: typeof staged.identity.ino === "bigint" };
    const currentStagedIdentity = await fs.lstat(stagedPath, stagedStatOptions);
    if (!sameFileStatFingerprint(staged.identity, currentStagedIdentity)) {
      throw new Error(`SQLite snapshot staging file changed during publication: ${stagedPath}`);
    }
    try {
      const publication = await publishFileExclusive({
        sourcePath: stagedPath,
        targetPath: options.targetPath,
        expectedSourceIdentity: currentStagedIdentity,
        strategy:
          options.requireAtomicPublication || consumeOwnedSource === "prepared"
            ? "link-required"
            : "link-or-copy",
      });
      publishedIdentity = publication.identity;
      // Keep the successful receipt before our durability policy can reject it;
      // dependency failures retain their own cleanup instead of a lossy receipt.
      requireDirectorySync(publication.directorySync, "File publication directory");
    } catch (error) {
      const details = getPublishFileExclusiveFailureDetails(error);
      const stagedAfterFailure = details?.targetCreated
        ? await fs.lstat(stagedPath, stagedStatOptions).catch(() => undefined)
        : undefined;
      const stagedPathChanged =
        !stagedAfterFailure || !sameFileStatFingerprint(staged.identity, stagedAfterFailure);
      // Failed-publication cleanup belongs to the publisher's opened identity.
      // A later staging/target lookup cannot grant ownership of a replacement.
      if (options.requireAtomicPublication && isHardlinkFallbackError(error)) {
        throw new Error(
          `Atomic SQLite publication requires hard-link support in ${targetDirectory}.`,
          { cause: error },
        );
      }
      if (details?.targetCreated) {
        if (stagedPathChanged) {
          throw new Error(
            `SQLite snapshot staging file changed during publication: ${options.targetPath}`,
            { cause: error },
          );
        }
        throw new Error(
          `SQLite snapshot target changed during publication: ${options.targetPath}`,
          { cause: error },
        );
      }
      throw error;
    }
    if (!publishedIdentity) {
      throw new Error(`SQLite snapshot target was not published: ${options.targetPath}`);
    }
    const initialPublishedIdentity = publishedIdentity;
    target = await fs.open(options.targetPath, "r");
    await assertOpenFileIdentity(target, options.targetPath, initialPublishedIdentity);
    // Retire the writable staging hard link before the final byte verification.
    await fs.unlink(stagedPath);
    const expectedIdentity = await target.stat();
    publishedIdentity = expectedIdentity;
    const publishedContent = await hashOpenPublishedFile(
      target,
      options.targetPath,
      expectedIdentity,
    );
    assertExpectedContent(publishedContent, expectedContent, options.targetPath);
    await fs.rmdir(stagingDir);
    requireDirectorySync(
      await syncDirectory(targetDirectoryReceipt),
      "SQLite publication directory",
    );
    await target.close();
    target = undefined;
    targetPinFileDescriptor = fsSync.openSync(options.targetPath, "r");
    assertOpenFileIdentitySync(targetPinFileDescriptor, options.targetPath, expectedIdentity);

    const guard: PublishedSqliteFileGuard = {
      assertTargetMatchesExpectedContent: (finalCheck) => {
        const content = hashPublishedFileSync(options.targetPath, expectedIdentity);
        assertExpectedContent(content, expectedContent, options.targetPath);
        assertSynchronousCallbackResult(finalCheck?.(), "SQLite publication final check");
        assertPublishedFileIdentitySync(options.targetPath, expectedIdentity, expectedContent);
      },
      assertTargetUnchanged: (finalCheck) => {
        assertPublishedFileIdentitySync(options.targetPath, expectedIdentity, expectedContent);
        assertSynchronousCallbackResult(finalCheck?.(), "SQLite publication final check");
        assertPublishedFileIdentitySync(options.targetPath, expectedIdentity, expectedContent);
      },
    };
    if (options.afterPublish) {
      assertSynchronousCallbackResult(
        options.afterPublish(guard),
        "SQLite after-publication guard",
      );
    } else {
      guard.assertTargetUnchanged();
    }
    fsSync.closeSync(targetPinFileDescriptor);
    targetPinFileDescriptor = undefined;
  } catch (error) {
    if (target && publishedIdentity) {
      const openedIdentity = await target.stat().catch(() => undefined);
      if (openedIdentity && sameFileIdentity(openedIdentity, publishedIdentity)) {
        publishedIdentity = openedIdentity;
      }
    }
    if (publishedIdentity && consumeOwnedSource !== "prepared") {
      // Windows can reuse a deleted file's identity while our old handle is still pinned.
      // Require the full fingerprint so cleanup never unlinks a caller replacement.
      const removed = removePublishedTargetIfOwned(options.targetPath, publishedIdentity, true);
      if (removed) {
        await syncDirectory(targetDirectoryReceipt).catch(() => undefined);
      }
    }
    // Recovery owns prepared bytes after displacement, even if publication or
    // its later metadata checks failed. Never remove their remaining name.
    if (consumeOwnedSource !== "prepared") {
      if (stagingIdentity) {
        await removePublicationStagingDirectory(stagingDir, stagingIdentity).catch(() => undefined);
      } else {
        await fs.rmdir(stagingDir).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    if (targetPinFileDescriptor !== undefined) {
      fsSync.closeSync(targetPinFileDescriptor);
    }
    if (target) {
      await target.close().catch(() => undefined);
    }
    if (source) {
      await source.close().catch(() => undefined);
    }
    await targetDirectoryPin.close().catch(() => undefined);
  }
}

/**
 * Compact one SQLite database into a fresh private file and verify the result.
 *
 * The source and output both receive full structural, index, and foreign-key
 * checks. Only a fully verified, synced snapshot is published to the target.
 * SQLite copies and checks vec0 shadow tables without loading sqlite-vec;
 * native extension loading here can crash backups on unsupported CPUs.
 */
export async function createVerifiedSqliteSnapshot(
  options: CreateVerifiedSqliteSnapshotOptions,
): Promise<VerifiedSqliteSnapshot> {
  const sourcePath = options.sourceAcquisition
    ? await fs.realpath(options.sourcePath)
    : options.sourcePath;
  await assertRegularSourceFile(sourcePath, options.requireNonEmptySource === true);
  await assertTargetAbsent(options.targetPath);

  if (options.preserveRowIds && !options.sourceAcquisition) {
    // Preserve physical pages as well as row IDs. Raw family descriptors must
    // stay outside a live native owner's process so close cannot release its locks.
    const prepared = await prepareSqliteReadOnlyLocation(sourcePath, {
      preserveSourceArtifacts: true,
    });
    return withPreparedSqliteSnapshot(prepared, (privateSourcePath) =>
      verifyAndPublishSqliteSnapshot(options, privateSourcePath),
    );
  }
  if (options.sourceAcquisition) {
    const prepared = options.sourceAcquisition.preserveSourceArtifacts
      ? await prepareSqliteReadOnlyCopyInProcess(sourcePath, options.sourceAcquisition.stagingRoot)
      : await prepareSqliteReadOnlyLocationInProcess(
          sourcePath,
          options.sourceAcquisition.stagingRoot,
          undefined,
          options.onProgress,
        );
    return withPreparedSqliteSnapshot(prepared, (privateSourcePath) =>
      verifyAndPublishSqliteSnapshot(options, privateSourcePath),
    );
  }
  return verifyAndPublishSqliteSnapshot(options);
}

async function verifyAndPublishSqliteSnapshot(
  options: CreateVerifiedSqliteSnapshotOptions,
  privateSourcePath?: string,
): Promise<VerifiedSqliteSnapshot> {
  const stagingDir = privateSourcePath
    ? path.dirname(privateSourcePath)
    : await createPrivateSqliteTempDirectory(path.dirname(options.targetPath), ".sqlite-snapshot-");
  await fs.chmod(stagingDir, 0o700);
  const stagedPath = privateSourcePath ?? path.join(stagingDir, "database.sqlite");
  let stagedIdentity: Stats | undefined;
  try {
    await withSqliteSnapshotSource(
      privateSourcePath ?? options.sourcePath,
      async (snapshotSourcePath) => {
        if (!privateSourcePath) {
          await fs.rm(stagedPath, { force: true });
        }
        const source = openNodeSqliteDatabase(snapshotSourcePath, {
          readOnly: true,
        });
        try {
          source.exec("PRAGMA busy_timeout = 30000; PRAGMA trusted_schema = OFF; BEGIN;");
          try {
            // Pin validation and backup together; Node restarts stepped backups on concurrent writes.
            source.prepare("PRAGMA schema_version;").get();
            assertSqliteIntegrity(source, options.sourcePath);
            options.validate?.(source, options.sourcePath);
            if (!privateSourcePath) {
              await backupNodeSqliteDatabase(source, stagedPath, options.onProgress);
            }
          } finally {
            source.exec("ROLLBACK;");
          }
        } finally {
          if (source.isOpen) {
            source.close();
          }
        }
      },
    );

    await fs.chmod(stagedPath, 0o600);
    const snapshot = openNodeSqliteDatabase(stagedPath);
    try {
      snapshot.exec("PRAGMA busy_timeout = 30000; PRAGMA trusted_schema = OFF;");
      // Online backup preserves WAL mode. Switch the private copy to rollback
      // journaling so verification and restore need only the published file.
      snapshot.exec("PRAGMA journal_mode = DELETE;");
      if (options.transform) {
        await options.transform(snapshot);
      }
      // Ordinary backups erase deleted/transformed data from free pages. Update
      // checkpoints opt out because VACUUM can rewrite implicit row IDs. DELETE
      // journaling above still makes the published artifact single-file.
      if (!options.preserveRowIds) {
        snapshot.exec("VACUUM;");
      }
      // Publication validates this output once, after transfer and before exposing the target.
      const userVersion = readSqliteUserVersion(snapshot);
      snapshot.close();
      await syncFile(stagedPath);
      stagedIdentity = await fs.lstat(stagedPath);
      const expectedContent = await hashPublishedFile(stagedPath, stagedIdentity);
      await publishSqliteFile(
        {
          sourceIdentity: stagedIdentity,
          sourcePath: stagedPath,
          targetPath: options.targetPath,
          expectedContent,
          beforePublish: options.beforePublish,
          afterPublish: options.afterPublish,
          validatePublished: (publishedPath) => {
            const published = openNodeSqliteDatabase(publishedPath, {
              readOnly: true,
            });
            try {
              published.exec("PRAGMA busy_timeout = 30000; PRAGMA trusted_schema = OFF;");
              assertSqliteIntegrity(published, options.targetPath);
              options.validate?.(published, options.targetPath);
              const publishedUserVersion = readSqliteUserVersion(published);
              if (publishedUserVersion !== userVersion) {
                throw new Error(
                  `SQLite snapshot user_version changed during publication: expected ${userVersion}, got ${publishedUserVersion}`,
                );
              }
            } finally {
              published.close();
            }
          },
        },
        true,
      );
      return { path: options.targetPath, userVersion, ...expectedContent };
    } finally {
      if (snapshot.isOpen) {
        snapshot.close();
      }
    }
  } catch (error) {
    throw new Error(
      `SQLite database cannot be snapshotted safely: ${options.sourcePath}. ${formatErrorMessage(error)}`,
      { cause: error },
    );
  } finally {
    if (!privateSourcePath) {
      await fs.rm(stagingDir, { force: true, recursive: true }).catch(() => undefined);
    }
  }
}
