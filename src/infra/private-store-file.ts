import fs from "node:fs";
import path from "node:path";
import {
  assertDirectoryIdentitySync,
  createDirectorySync,
  createFileSync,
} from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { applyPrivateModeSync } from "./private-mode.js";

function createPrivateIfMissing(create: () => void): boolean {
  try {
    create();
    return true;
  } catch (error) {
    if (!(error instanceof FsSafeError && error.code === "already-exists")) {
      throw error;
    }
    return false;
  }
}

function createPrivateStoreDirectorySync(directory: string): void {
  const parentPath = path.dirname(directory);
  const parent =
    process.platform === "linux" ? fs.lstatSync(parentPath, { bigint: true }) : undefined;
  try {
    createDirectorySync(directory, { private: true });
  } catch (error) {
    const publication = error instanceof FsSafeError ? error.details?.publication : undefined;
    if (
      process.platform !== "linux" ||
      typeof process.getuid !== "function" ||
      !parent ||
      !(error instanceof FsSafeError && error.code === "helper-failed") ||
      !(error.cause instanceof FsSafeError && error.cause.code === "insecure-permissions") ||
      error.details?.path !== directory ||
      !publication ||
      typeof publication !== "object" ||
      !("status" in publication && publication.status === "published")
    ) {
      throw error;
    }
    // Linux inherits setgid even for mkdir(0700). Normalize only this published,
    // owner-only directory; all other private-creation refusals remain failures.
    let fd: number | undefined;
    try {
      assertDirectoryIdentitySync(parentPath, parent);
      fd = fs.openSync(
        directory,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
      const created = fs.fstatSync(fd, { bigint: true });
      const named = fs.lstatSync(directory, { bigint: true });
      if (
        !created.isDirectory() ||
        created.uid !== BigInt(process.getuid()) ||
        (created.mode & 0o7777n) !== 0o2700n ||
        created.dev !== named.dev ||
        created.ino !== named.ino
      ) {
        throw error;
      }
      assertDirectoryIdentitySync(parentPath, parent);
      fs.fchmodSync(fd, 0o700);
      const normalized = fs.fstatSync(fd, { bigint: true });
      const current = fs.lstatSync(directory, { bigint: true });
      if (
        (normalized.mode & 0o7777n) !== 0o700n ||
        normalized.dev !== current.dev ||
        normalized.ino !== current.ino
      ) {
        throw error;
      }
      assertDirectoryIdentitySync(parentPath, parent);
    } catch {
      throw error;
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }
  }
}

/** The caller admits the existing parent before preparing this store's private file. */
export function preparePrivateStoreFileSync(pathname: string, directoryExists: boolean): boolean {
  const directory = path.dirname(pathname);
  if (!directoryExists) {
    fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  }
  // State roots may be aliases; private children must still be real directories.
  const creationDirectory = path.join(
    fs.realpathSync.native(path.dirname(directory)),
    path.basename(directory),
  );
  if (!directoryExists) {
    createPrivateIfMissing(() => createPrivateStoreDirectorySync(creationDirectory));
  }
  applyPrivateModeSync(directory, 0o700);
  if (!fs.existsSync(pathname)) {
    return createPrivateIfMissing(() =>
      createFileSync(path.join(creationDirectory, path.basename(pathname)), {
        private: true,
      }).close(),
    );
  }
  return false;
}
