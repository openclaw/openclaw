// Reads and copies a pinned SQLite source file without touching its sidecars.
import fs, { type BigIntStats } from "node:fs";
import {
  copyFileDescriptorSync,
  sameFileContentsSync,
  sameFileIdentity,
} from "@openclaw/fs-safe/advanced";

const SQLITE_HEADER_BYTES = 20;

export type PinnedFile = {
  descriptor: number;
  identity: BigIntStats;
  pathname: string;
};

export type SourceSidecars = {
  journal: boolean;
  shm: boolean;
  wal: boolean;
};

export type SourceJournalMode = "empty" | "rollback" | "unknown" | "wal";

export class SqliteSourceChangedError extends Error {}

export function statIfPresent(pathname: string): BigIntStats | undefined {
  try {
    return fs.statSync(pathname, { bigint: true });
  } catch (error) {
    // SAFETY: statSync on this canonical string path reports Node errno failures.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function readSourceSidecars(pathname: string): SourceSidecars {
  return {
    journal: Boolean(statIfPresent(`${pathname}-journal`)),
    shm: Boolean(statIfPresent(`${pathname}-shm`)),
    wal: Boolean(statIfPresent(`${pathname}-wal`)),
  };
}

function sameSidecars(left: SourceSidecars, right: SourceSidecars): boolean {
  return left.journal === right.journal && left.shm === right.shm && left.wal === right.wal;
}

export function openPinnedFile(pathname: string): PinnedFile {
  let descriptor: number;
  try {
    descriptor = fs.openSync(pathname, "r");
  } catch (error) {
    // SAFETY: openSync on this canonical string path reports Node errno failures.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SqliteSourceChangedError(`SQLite source disappeared: ${pathname}`);
    }
    throw error;
  }
  try {
    const identity = fs.fstatSync(descriptor, { bigint: true });
    const current = statIfPresent(pathname);
    if (!identity.isFile() || !current?.isFile() || !sameFileIdentity(identity, current)) {
      throw new SqliteSourceChangedError(`SQLite source changed while opening: ${pathname}`);
    }
    return { descriptor, identity, pathname };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

export function readSourceJournalMode(pathname: string): SourceJournalMode {
  const source = openPinnedFile(pathname);
  try {
    const header = Buffer.alloc(SQLITE_HEADER_BYTES);
    const bytesRead = fs.readSync(source.descriptor, header, 0, header.length, 0);
    const confirmedHeader = Buffer.alloc(SQLITE_HEADER_BYTES);
    const confirmedBytesRead = fs.readSync(
      source.descriptor,
      confirmedHeader,
      0,
      confirmedHeader.length,
      0,
    );
    assertPinnedIdentityUnchanged(source);
    if (bytesRead === 0 && confirmedBytesRead === 0) {
      return "empty";
    }
    if (
      bytesRead !== header.length ||
      confirmedBytesRead !== confirmedHeader.length ||
      !header.equals(confirmedHeader) ||
      header.subarray(0, 16).toString("utf8") !== "SQLite format 3\u0000"
    ) {
      return "unknown";
    }
    return header[18] === 2 || header[19] === 2 ? "wal" : "rollback";
  } finally {
    fs.closeSync(source.descriptor);
  }
}

export function assertPinnedIdentityUnchanged(file: PinnedFile): void {
  const opened = fs.fstatSync(file.descriptor, { bigint: true });
  const current = statIfPresent(file.pathname);
  if (
    !opened.isFile() ||
    !current?.isFile() ||
    !sameFileIdentity(file.identity, opened) ||
    !sameFileIdentity(file.identity, current)
  ) {
    throw new SqliteSourceChangedError(`SQLite source changed while copying: ${file.pathname}`);
  }
}

function copyPinnedFile(source: PinnedFile, targetPath: string): void {
  let target: number | undefined;
  try {
    target = fs.openSync(targetPath, "wx", 0o600);
    copyFileDescriptorSync(source.descriptor, target);
    fs.fsyncSync(target);
    assertPinnedIdentityUnchanged(source);
  } finally {
    if (target !== undefined) {
      fs.closeSync(target);
    }
  }
}

export function copySourceFile(sourcePath: string, targetPath: string): void {
  const source = openPinnedFile(sourcePath);
  try {
    copyPinnedFile(source, targetPath);
  } finally {
    fs.closeSync(source.descriptor);
  }
}

export function sourceMatchesCopy(sourcePath: string, copyPath: string): boolean {
  const source = openPinnedFile(sourcePath);
  let copy: number | undefined;
  try {
    copy = fs.openSync(copyPath, "r");
    if (!fs.fstatSync(copy).isFile()) {
      return false;
    }
    const equal = sameFileContentsSync(source.descriptor, copy);
    assertPinnedIdentityUnchanged(source);
    return equal;
  } finally {
    try {
      if (copy !== undefined) {
        fs.closeSync(copy);
      }
    } finally {
      fs.closeSync(source.descriptor);
    }
  }
}

export function assertExpectedSidecars(pathname: string, expected: SourceSidecars): void {
  if (!sameSidecars(readSourceSidecars(pathname), expected)) {
    throw new SqliteSourceChangedError(`SQLite journal state changed while copying: ${pathname}`);
  }
}

export function replaceFile(sourcePath: string, targetPath: string): void {
  fs.rmSync(targetPath, { force: true });
  fs.renameSync(sourcePath, targetPath);
}
