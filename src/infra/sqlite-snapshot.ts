// Creates verified SQLite snapshots, compacting by default.
import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity, type FileIdentityStat } from "@openclaw/fs-safe/advanced";
import {
  getPublishFileExclusiveFailureDetails,
  isHardlinkFallbackError,
  pinDirectory,
  publishFileExclusive,
  requireDirectorySync,
  syncDirectory,
} from "./directory-durability.js";
import { formatErrorMessage } from "./errors.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { backupNodeSqliteDatabase } from "./sqlite-backup.js";
import { copySqliteFile } from "./sqlite-file-copy.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";
import { captureSqliteMaintenanceIntegrity } from "./sqlite-maintenance-integrity.js";
import { createPrivateSqliteTempDirectory } from "./sqlite-private-directory.js";
import { withPreparedSqliteSnapshot } from "./sqlite-readonly-location-cleanup.js";
import {
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyCopyInProcess,
} from "./sqlite-readonly-location.js";
import {
  assertExpectedContent,
  assertMutationFingerprintUnchanged,
  assertOpenFileIdentity,
  assertOpenFileIdentitySync,
  assertPublishedFileIdentitySync,
  hashOpenPublishedFile,
  hashPublishedFile,
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
import type {
  CreateVerifiedSqliteSnapshotOptions,
  PublishedSqliteFileGuard,
  PublishVerifiedSqliteFileOptions,
  VerifiedSqliteSnapshot,
} from "./sqlite-snapshot.types.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import { configureSqliteSnapshotPragmas } from "./sqlite-wal.js";

export type { SqliteSnapshotValidator } from "./sqlite-snapshot.types.js";

export type SqliteReplacementReceipt = SqliteFileContent & {
  targetPath: string;
  identity: FileIdentityStat;
};

export class SqliteReplacementOutcomeUnknownError extends Error {
  constructor(
    readonly receipt: SqliteReplacementReceipt,
    cause: unknown,
  ) {
    super(
      `SQLite replacement outcome is uncertain: ${receipt.targetPath}. Reconcile the target against the retained recovery manifest before retrying.`,
      { cause },
    );
    this.name = "SqliteReplacementOutcomeUnknownError";
  }
}

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
  expectedContent: SqliteFileContent,
  beforeByteCopy?: PublishVerifiedSqliteFileOptions["beforeByteCopy"],
): Promise<BigIntStats> {
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
    await assertMutationFingerprintUnchanged(
      source,
      sourceFingerprint,
      targetPath,
      expectedContent,
    );
    await target.sync();
    const currentIdentity = await fs.lstat(targetPath, { bigint: true });
    if (!sameFileIdentity(targetIdentity, currentIdentity)) {
      throw new Error(`SQLite snapshot target changed during publication: ${targetPath}`);
    }
    return currentIdentity;
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

async function syncFile(filePath: string): Promise<void> {
  await using handle = await fs.open(filePath, "r+");
  await handle.sync();
}

/** Only the native updater's stopped, checkpointed inventory may use raw file capture. */
export async function createStoppedSqliteSnapshot(options: {
  sourcePath: string;
  targetPath: string;
  sourceIdentity: BigIntStats;
}): Promise<VerifiedSqliteSnapshot> {
  if (options.sourceIdentity.size === 0n) {
    throw new Error(`SQLite snapshot source must not be empty: ${options.sourcePath}`);
  }
  const publication = await copySqliteFile(
    options.sourcePath,
    options.targetPath,
    options.sourceIdentity,
  );
  const snapshot = openNodeSqliteDatabase(options.targetPath);
  let userVersion: number;
  try {
    configureSqliteSnapshotPragmas(snapshot);
    userVersion = readSqliteUserVersion(snapshot);
  } finally {
    snapshot.close();
  }
  const identity = await fs.lstat(options.targetPath, { bigint: true });
  if (!sameFileIdentity(publication, identity) || identity.size !== options.sourceIdentity.size) {
    throw new Error(`SQLite snapshot file changed: ${options.targetPath}`);
  }
  await syncFile(options.targetPath);
  // Restore requires this digest; the stopped owner checks source/journal stability separately.
  const content = await hashPublishedFile(options.targetPath, identity);
  return { path: options.targetPath, userVersion, ...content };
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
 * source identity. Targets are exclusive unless replacement is explicitly requested.
 */
export async function publishVerifiedSqliteFile(
  options: PublishVerifiedSqliteFileOptions,
): Promise<void | SqliteReplacementReceipt> {
  return publishSqliteFile(options, false);
}

/** Prepare an independent writable image beside its destination before replacing current state. */
export async function prepareVerifiedSqliteFile(options: PublishVerifiedSqliteFileOptions) {
  const directory = await createPrivateSqliteTempDirectory(
    path.dirname(options.targetPath),
    ".sqlite-publish-prepared-",
  );
  const directoryIdentity = await fs.lstat(directory, { bigint: true });
  const sourcePath = path.join(directory, "database.sqlite");
  const cleanup = () => removePublicationStagingDirectory(directory, directoryIdentity);
  try {
    let sourceIdentity: BigIntStats | undefined;
    await publishVerifiedSqliteFile({
      ...options,
      targetPath: sourcePath,
      replaceExisting: undefined,
      afterPublish: (guard) => {
        assertSynchronousCallbackResult(
          options.afterPublish?.(guard),
          "SQLite after-publication guard",
        );
        sourceIdentity = fsSync.lstatSync(sourcePath, { bigint: true });
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
): Promise<void | SqliteReplacementReceipt> {
  const replacement = options.replaceExisting;
  if (replacement) {
    if (process.platform === "win32") {
      throw new Error("Atomic SQLite replacement is unsupported on this platform");
    }
    assertExpectedContent(
      hashPublishedFileSync(options.targetPath, replacement.expectedIdentity),
      replacement.expectedContent,
      options.targetPath,
    );
  } else {
    await assertTargetAbsent(options.targetPath);
  }
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
        : await createPrivateSqliteTempDirectory(targetDirectory, ".sqlite-publish-");
  } catch (error) {
    await targetDirectoryPin.close().catch(() => undefined);
    throw error;
  }
  const stagedPath = path.join(stagingDir, "database.sqlite");
  let stagingIdentity: BigIntStats | undefined;
  let source: FileHandle | undefined;
  let target: FileHandle | undefined;
  let targetPinFileDescriptor: number | undefined;
  let publishedIdentity: FileIdentityStat | undefined;
  let publishedStat: Stats | BigIntStats | undefined;
  let replacementAttempt: SqliteReplacementReceipt | undefined;
  try {
    stagingIdentity = await fs.lstat(stagingDir, { bigint: true });
    await fs.chmod(stagingDir, 0o700);
    source = await fs.open(options.sourcePath, "r");
    await assertOpenFileIdentity(source, options.sourcePath, options.sourceIdentity);
    const sourceIdentity = await source.stat({ bigint: true });
    // Snapshot creation owns this closed private image. Transfer that image into
    // publication custody instead of allocating another database-sized file.
    // Public callers retain their independently mutable source and still copy it.
    let staged: FileIdentityStat & { size: bigint };
    let transferredOwnedImage = false;
    if (consumeOwnedSource === "prepared") {
      if (options.sourcePath !== stagedPath || sourceIdentity.dev !== stagingIdentity.dev) {
        throw new Error(
          `SQLite prepared image is not on its publication volume: ${options.sourcePath}`,
        );
      }
      staged = sourceIdentity;
    } else if (
      consumeOwnedSource &&
      sourceIdentity.dev !== 0n &&
      sourceIdentity.ino !== 0n &&
      sourceIdentity.dev === stagingIdentity.dev
    ) {
      const moved = await publishFileExclusive({
        sourcePath: options.sourcePath,
        targetPath: stagedPath,
        expectedSourceIdentity: sourceIdentity,
        strategy: "link-or-copy",
      });
      requireDirectorySync(moved.directorySync, "SQLite staging transfer directory");
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
      const identity = await fs.lstat(stagedPath, { bigint: true });
      if (
        !sameFileIdentity(moved.exactIdentity, identity) ||
        moved.identity.size !== Number(identity.size)
      ) {
        throw new Error(`SQLite snapshot staging file changed during transfer: ${stagedPath}`);
      }
      staged = { ...moved.exactIdentity, size: identity.size };
      transferredOwnedImage = moved.method === "hardlink";
    } else {
      staged = await copyFileExclusive(
        source,
        options.sourcePath,
        stagedPath,
        options.expectedContent,
        options.beforeByteCopy,
      );
    }
    const expectedContent = options.expectedContent;
    await source.close();
    source = undefined;

    await options.validatePublished?.(stagedPath);
    // An owned hard-link transfer keeps its original digest; final publication
    // still compares the complete image. Independently copied files need admission.
    if (!transferredOwnedImage) {
      const validatedContent = await hashPublishedFile(stagedPath, staged);
      assertExpectedContent(validatedContent, expectedContent, options.targetPath);
    }
    await options.beforePublish?.();
    if (!replacement) {
      await assertTargetAbsent(options.targetPath);
    }
    const stagedStatOptions = { bigint: true } as const;
    const currentStagedIdentity = await fs.lstat(stagedPath, stagedStatOptions);
    if (!sameFileStatFingerprint(staged, currentStagedIdentity)) {
      throw new Error(`SQLite snapshot staging file changed during publication: ${stagedPath}`);
    }
    if (replacement) {
      const directoryIdentity = await fs.lstat(targetDirectory, { bigint: true });
      if (directoryIdentity.dev !== currentStagedIdentity.dev) {
        throw new Error("Atomic SQLite replacement requires a same-volume prepared image");
      }
      const durability = await syncDirectory(targetDirectoryReceipt);
      if (durability.status !== "synced") {
        throw new Error("Atomic SQLite replacement requires directory synchronization");
      }
      assertExpectedContent(
        hashPublishedFileSync(options.targetPath, replacement.expectedIdentity),
        replacement.expectedContent,
        options.targetPath,
      );
      assertExpectedContent(
        hashPublishedFileSync(stagedPath, currentStagedIdentity),
        expectedContent,
        stagedPath,
      );
      assertSynchronousCallbackResult(replacement.assertCustody(), "SQLite replacement custody");
      replacementAttempt = {
        targetPath: options.targetPath,
        identity: currentStagedIdentity,
        ...expectedContent,
      };
      fsSync.renameSync(stagedPath, options.targetPath);
      publishedIdentity = currentStagedIdentity;
      publishedStat = currentStagedIdentity;
    } else {
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
        publishedIdentity = publication.exactIdentity;
        publishedStat = publication.identity;
        // Keep the successful receipt before our durability policy can reject it;
        // dependency failures retain their own cleanup instead of a lossy receipt.
        requireDirectorySync(publication.directorySync, "File publication directory");
      } catch (error) {
        const details = getPublishFileExclusiveFailureDetails(error);
        const stagedAfterFailure = details?.targetCreated
          ? await fs.lstat(stagedPath, stagedStatOptions).catch(() => undefined)
          : undefined;
        const stagedPathChanged =
          !stagedAfterFailure || !sameFileStatFingerprint(staged, stagedAfterFailure);
        // Failed-publication cleanup belongs to the publisher's opened identity.
        // A later staging/target lookup cannot grant ownership of a replacement.
        if (options.requireAtomicPublication && isHardlinkFallbackError(error)) {
          throw new Error(
            `Atomic SQLite publication requires hard-link support in ${targetDirectory}.`,
            { cause: error },
          );
        }
        if (details?.targetCreated) {
          const changed = stagedPathChanged ? "staging file" : "target";
          throw new Error(
            `SQLite snapshot ${changed} changed during publication: ${options.targetPath}`,
            { cause: error },
          );
        }
        throw error;
      }
    }
    const initialPublishedIdentity = publishedIdentity;
    target = await fs.open(options.targetPath, "r");
    await assertOpenFileIdentity(target, options.targetPath, initialPublishedIdentity);
    // Retire the writable staging hard link before the final byte verification.
    if (!replacement) {
      await fs.unlink(stagedPath);
    }
    const expectedIdentity = await target.stat({ bigint: true });
    publishedIdentity = expectedIdentity;
    publishedStat = expectedIdentity;
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
        // Keep the pre-hash fingerprint: later timestamp changes must miss content reuse,
        // including when publication's FUSE recheck accepted unchanged bytes.
        return { stat: expectedIdentity, content: publishedContent };
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
    if (replacementAttempt) {
      return { ...replacementAttempt, identity: expectedIdentity };
    }
  } catch (error) {
    if (replacementAttempt) {
      throw new SqliteReplacementOutcomeUnknownError(replacementAttempt, error);
    }
    if (target && publishedIdentity) {
      const openedIdentity = await target.stat({ bigint: true }).catch(() => undefined);
      if (openedIdentity && sameFileIdentity(openedIdentity, publishedIdentity)) {
        publishedIdentity = openedIdentity;
        publishedStat = openedIdentity;
      }
    }
    if (publishedIdentity && publishedStat && consumeOwnedSource !== "prepared") {
      // Windows can reuse a deleted file's identity while our old handle is still pinned.
      // Require the full fingerprint so cleanup never unlinks a caller replacement.
      const removed = removePublishedTargetIfOwned(
        options.targetPath,
        publishedIdentity,
        publishedStat,
      );
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
 * The final private image receives integrity and foreign-key checks before
 * publication. Source checks also precede rewrites, backups, and caller validators.
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
    const recordSourceIntegrity = captureSqliteMaintenanceIntegrity(sourcePath, options.integrity);
    const prepared = await prepareSqliteReadOnlyLocation(sourcePath, {
      preserveSourceArtifacts: true,
    });
    return withPreparedSqliteSnapshot(prepared, (privateSourcePath) =>
      verifyAndPublishSqliteSnapshot(options, privateSourcePath, recordSourceIntegrity),
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
  recordSourceIntegrity?: () => void,
): Promise<VerifiedSqliteSnapshot> {
  const stagingDir = privateSourcePath
    ? path.dirname(privateSourcePath)
    : await createPrivateSqliteTempDirectory(path.dirname(options.targetPath), ".sqlite-snapshot-");
  await fs.chmod(stagingDir, 0o700);
  const stagedPath = privateSourcePath ?? path.join(stagingDir, "database.sqlite");
  let stagedIdentity: BigIntStats | undefined;
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
            const autoVacuum =
              privateSourcePath &&
              options.preserveRowIds === true &&
              !options.transform &&
              !options.validate
                ? source.prepare("PRAGMA auto_vacuum;").get()?.auto_vacuum
                : undefined;
            // FULL auto-vacuum can rewrite pages when journal normalization commits.
            // Only normalization without rewrites or callbacks can defer admission
            // to the final private image; all publication byte checks still apply.
            if (autoVacuum !== 0 && autoVacuum !== 2) {
              assertSqliteIntegrity(source, options.sourcePath, options.integrity);
              recordSourceIntegrity?.();
            }
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
      // Online backup preserves WAL mode. Switch the private copy to rollback
      // journaling so verification and restore need only the published file.
      configureSqliteSnapshotPragmas(snapshot);
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
      stagedIdentity = await fs.lstat(stagedPath, { bigint: true });
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
              assertSqliteIntegrity(published, options.targetPath, options.integrity);
              options.validate?.(published, options.targetPath);
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
