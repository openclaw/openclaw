import type { BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { copySqliteFile } from "./sqlite-file-copy.js";
import {
  assertMutationFingerprintUnchanged,
  removePublishedTargetIfOwned,
  type SqliteFileContent,
} from "./sqlite-snapshot-file.js";
import type { PublishVerifiedSqliteFileOptions } from "./sqlite-snapshot.types.js";

/** Copy a pinned source to an absent target, fsync it, and remove only our own partial target. */
export async function copyFileExclusive(
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
    const publication = await copySqliteFile(sourcePath, targetPath, sourceFingerprint, {
      beforeByteCopy,
    });
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
