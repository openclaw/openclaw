import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { hashFileDescriptorSync, sameFileMutationFingerprint } from "./file-descriptor.js";
import { readDatabaseIdentityBirthtime } from "./sqlite-worker-identity.js";

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
  expectedIdentity: Stats,
  expectedContent: SqliteFileContent,
): void {
  const currentIdentity = fsSync.lstatSync(filePath);
  if (
    !currentIdentity.isFile() ||
    !sameFileIdentity(expectedIdentity, currentIdentity) ||
    expectedIdentity.size !== currentIdentity.size ||
    expectedIdentity.birthtimeMs !== currentIdentity.birthtimeMs
  ) {
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
  expectedIdentity: Stats | BigIntStats,
): void {
  const options = { bigint: typeof expectedIdentity.ino === "bigint" };
  const openedIdentity = fsSync.fstatSync(fileDescriptor, options);
  const currentIdentity = fsSync.lstatSync(filePath, options);
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
  expectedIdentity: Stats | BigIntStats,
): SqliteFileContent {
  const fileDescriptor = fsSync.openSync(filePath, "r");
  try {
    assertOpenFileIdentitySync(fileDescriptor, filePath, expectedIdentity);
    const initialStat = fsSync.fstatSync(fileDescriptor, { bigint: true });
    const content = hashFileDescriptorSync(fileDescriptor);
    const finalStat = fsSync.fstatSync(fileDescriptor, { bigint: true });
    if (!sameFileMutationFingerprint(initialStat, finalStat)) {
      if (
        initialStat.dev !== finalStat.dev ||
        initialStat.ino !== finalStat.ino ||
        readDatabaseIdentityBirthtime(initialStat) !== readDatabaseIdentityBirthtime(finalStat) ||
        initialStat.size !== finalStat.size
      ) {
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
  expectedIdentity: Stats | BigIntStats,
  requireFingerprint = false,
): boolean {
  let currentIdentity: Stats | BigIntStats;
  try {
    currentIdentity = fsSync.lstatSync(filePath, {
      bigint: typeof expectedIdentity.ino === "bigint",
    });
  } catch {
    return false;
  }
  const fingerprintMatches =
    !requireFingerprint ||
    (expectedIdentity.size === currentIdentity.size &&
      expectedIdentity.mtimeMs === currentIdentity.mtimeMs &&
      expectedIdentity.ctimeMs === currentIdentity.ctimeMs &&
      expectedIdentity.birthtimeMs === currentIdentity.birthtimeMs);
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
  left: Stats | BigIntStats,
  right: Stats | BigIntStats,
): boolean {
  // Linking/unlinking changes ctime, which Linux can expose as birthtime without statx.
  // Publication separately verifies bytes; timestamps do not identify the transferred file.
  return sameFileIdentity(left, right) && left.size === right.size;
}

export async function removePublicationStagingDirectory(
  stagingDir: string,
  expectedIdentity: Stats,
): Promise<void> {
  const currentIdentity = await fs.lstat(stagingDir).catch(() => undefined);
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
