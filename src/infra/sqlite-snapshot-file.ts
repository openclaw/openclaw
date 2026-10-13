import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity, type FileIdentityStat } from "@openclaw/fs-safe/advanced";
import { hashFileDescriptorSync, sameFileMutationFingerprint } from "./file-descriptor.js";

export type SqliteFileContent = {
  sha256: string;
  sizeBytes: number;
};

export function assertExpectedContent(
  actual: SqliteFileContent,
  expected: SqliteFileContent,
  filePath: string,
): void {
  if (actual.sizeBytes !== expected.sizeBytes) {
    throw new Error(
      `SQLite snapshot size mismatch for ${filePath}: expected ${expected.sizeBytes}, got ${actual.sizeBytes}`,
    );
  }
  if (actual.sha256 !== expected.sha256) {
    throw new Error(
      `SQLite snapshot hash mismatch for ${filePath}: expected ${expected.sha256}, got ${actual.sha256}`,
    );
  }
}

export function assertPublishedFileIdentitySync(
  filePath: string,
  expectedIdentity: BigIntStats,
  expectedContent: SqliteFileContent,
): void {
  const currentIdentity = fsSync.lstatSync(filePath, { bigint: true });
  if (!currentIdentity.isFile() || !sameFileStatFingerprint(expectedIdentity, currentIdentity)) {
    throw new Error(`SQLite snapshot file changed: ${filePath}`);
  }
  if (
    expectedIdentity.mtimeMs !== currentIdentity.mtimeMs ||
    expectedIdentity.ctimeMs !== currentIdentity.ctimeMs
  ) {
    assertExpectedContent(
      hashPublishedFileSync(filePath, expectedIdentity),
      expectedContent,
      filePath,
    );
  }
}

export function assertOpenFileIdentitySync(
  fileDescriptor: number,
  filePath: string,
  expectedIdentity: FileIdentityStat,
): void {
  const openedIdentity = fsSync.fstatSync(fileDescriptor, { bigint: true });
  const currentIdentity = fsSync.lstatSync(filePath, { bigint: true });
  if (
    !openedIdentity.isFile() ||
    !currentIdentity.isFile() ||
    !sameFileIdentity(expectedIdentity, openedIdentity) ||
    !sameFileIdentity(expectedIdentity, currentIdentity)
  ) {
    throw new Error(`SQLite snapshot file changed: ${filePath}`);
  }
}

export function hashPublishedFileSync(
  filePath: string,
  expectedIdentity: FileIdentityStat,
): SqliteFileContent {
  const fileDescriptor = fsSync.openSync(filePath, "r");
  try {
    assertOpenFileIdentitySync(fileDescriptor, filePath, expectedIdentity);
    const initialStat = fsSync.fstatSync(fileDescriptor, { bigint: true });
    const content = hashFileDescriptorSync(fileDescriptor);
    const finalStat = fsSync.fstatSync(fileDescriptor, { bigint: true });
    if (!sameFileMutationFingerprint(initialStat, finalStat)) {
      if (!sameFileStatFingerprint(initialStat, finalStat)) {
        throw new Error(`SQLite snapshot file changed while reading: ${filePath}`);
      }
      // FUSE may settle timestamps after publication; only matching bytes can admit that drift.
      assertExpectedContent(hashFileDescriptorSync(fileDescriptor), content, filePath);
    }
    assertOpenFileIdentitySync(fileDescriptor, filePath, expectedIdentity);
    return content;
  } finally {
    fsSync.closeSync(fileDescriptor);
  }
}

export function removePublishedTargetIfOwned(
  filePath: string,
  expectedIdentity: FileIdentityStat,
  expectedFingerprint?: Stats | BigIntStats,
): boolean {
  let currentIdentity: BigIntStats;
  let currentFingerprint: Stats | BigIntStats;
  try {
    currentIdentity = fsSync.lstatSync(filePath, { bigint: true });
    currentFingerprint =
      expectedFingerprint && typeof expectedFingerprint.size === "number"
        ? fsSync.lstatSync(filePath)
        : currentIdentity;
  } catch {
    return false;
  }
  const fingerprintMatches =
    !expectedFingerprint ||
    (expectedFingerprint.size === currentFingerprint.size &&
      expectedFingerprint.mtimeMs === currentFingerprint.mtimeMs &&
      expectedFingerprint.ctimeMs === currentFingerprint.ctimeMs &&
      expectedFingerprint.birthtimeMs === currentFingerprint.birthtimeMs);
  // Unknown Windows identity can admit a read, but cannot authorize deletion.
  const unknownIdentity =
    process.platform === "win32" &&
    [expectedIdentity.dev, expectedIdentity.ino, currentIdentity.dev, currentIdentity.ino].some(
      (value) => value === 0 || value === 0n,
    );
  if (
    !currentIdentity.isFile() ||
    unknownIdentity ||
    !sameFileIdentity(expectedIdentity, currentIdentity) ||
    !fingerprintMatches
  ) {
    return false;
  }
  // Node has no cross-platform unlink-by-inode primitive. Keep the ownership
  // check and unlink synchronous so no in-process task can replace the path.
  try {
    fsSync.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function sameFileStatFingerprint(
  left: Pick<Stats | BigIntStats, "dev" | "ino" | "size">,
  right: Pick<Stats | BigIntStats, "dev" | "ino" | "size">,
): boolean {
  // Linking/unlinking changes ctime, which Linux can expose as birthtime without statx.
  // Publication separately verifies bytes; timestamps do not identify the transferred file.
  return sameFileIdentity(left, right) && left.size === right.size;
}

export async function removePublicationStagingDirectory(
  stagingDir: string,
  expectedIdentity: FileIdentityStat,
): Promise<void> {
  const currentIdentity = await fs.lstat(stagingDir, { bigint: true }).catch(() => undefined);
  if (!currentIdentity) {
    return;
  }
  if (!currentIdentity.isDirectory() || !sameFileIdentity(expectedIdentity, currentIdentity)) {
    throw new Error(`SQLite publication staging directory changed: ${stagingDir}`);
  }
  const entries = await fs.readdir(stagingDir, { withFileTypes: true });
  if (
    entries.length > 1 ||
    entries.some((entry) => entry.name !== "database.sqlite" || !entry.isFile())
  ) {
    throw new Error(`SQLite publication staging directory has unexpected contents: ${stagingDir}`);
  }
  const stagedEntry = entries[0];
  if (stagedEntry) {
    await fs.unlink(path.join(stagingDir, stagedEntry.name));
  }
  await fs.rmdir(stagingDir);
}
