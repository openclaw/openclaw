import type { Stats } from "node:fs";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity } from "./file-identity.js";
import { assertNoPathAliasEscape } from "./path-alias-guards.js";
import { isNotFoundPathError, isPathInside, isSymlinkOpenError } from "./path-guards.js";

export type SafeOpenErrorCode =
  | "invalid-path"
  | "not-found"
  | "symlink"
  | "not-file"
  | "path-mismatch"
  | "too-large";

export class SafeOpenError extends Error {
  code: SafeOpenErrorCode;

  constructor(code: SafeOpenErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "SafeOpenError";
  }
}

export type SafeOpenResult = {
  handle: FileHandle;
  realPath: string;
  stat: Stats;
};

export type SafeLocalReadResult = {
  buffer: Buffer;
  realPath: string;
  stat: Stats;
};

const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in fsConstants;
const OPEN_READ_FLAGS = fsConstants.O_RDONLY | (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
const OPEN_WRITE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_TRUNC |
  (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);

const ensureTrailingSep = (value: string) => (value.endsWith(path.sep) ? value : value + path.sep);

async function openVerifiedLocalFile(
  filePath: string,
  options?: {
    rejectHardlinks?: boolean;
  },
): Promise<SafeOpenResult> {
  let handle: FileHandle;
  try {
    handle = await fs.open(filePath, OPEN_READ_FLAGS);
  } catch (err) {
    if (isNotFoundPathError(err)) {
      throw new SafeOpenError("not-found", "file not found");
    }
    if (isSymlinkOpenError(err)) {
      throw new SafeOpenError("symlink", "symlink open blocked", { cause: err });
    }
    throw err;
  }

  try {
    const [stat, lstat] = await Promise.all([handle.stat(), fs.lstat(filePath)]);
    if (lstat.isSymbolicLink()) {
      throw new SafeOpenError("symlink", "symlink not allowed");
    }
    if (!stat.isFile()) {
      throw new SafeOpenError("not-file", "not a file");
    }
    if (options?.rejectHardlinks && stat.nlink > 1) {
      throw new SafeOpenError("invalid-path", "hardlinked path not allowed");
    }
    if (!sameFileIdentity(stat, lstat)) {
      throw new SafeOpenError("path-mismatch", "path changed during read");
    }

    const realPath = await fs.realpath(filePath);
    const realStat = await fs.stat(realPath);
    if (options?.rejectHardlinks && realStat.nlink > 1) {
      throw new SafeOpenError("invalid-path", "hardlinked path not allowed");
    }
    if (!sameFileIdentity(stat, realStat)) {
      throw new SafeOpenError("path-mismatch", "path mismatch");
    }

    return { handle, realPath, stat };
  } catch (err) {
    await handle.close().catch(() => {});
    if (err instanceof SafeOpenError) {
      throw err;
    }
    if (isNotFoundPathError(err)) {
      throw new SafeOpenError("not-found", "file not found");
    }
    throw err;
  }
}

export async function openFileWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  rejectHardlinks?: boolean;
}): Promise<SafeOpenResult> {
  let rootReal: string;
  try {
    rootReal = await fs.realpath(params.rootDir);
  } catch (err) {
    if (isNotFoundPathError(err)) {
      throw new SafeOpenError("not-found", "root dir not found");
    }
    throw err;
  }
  const rootWithSep = ensureTrailingSep(rootReal);
  const resolved = path.resolve(rootWithSep, params.relativePath);
  if (!isPathInside(rootWithSep, resolved)) {
    throw new SafeOpenError("invalid-path", "path escapes root");
  }

  let opened: SafeOpenResult;
  try {
    opened = await openVerifiedLocalFile(resolved);
  } catch (err) {
    if (err instanceof SafeOpenError) {
      if (err.code === "not-found") {
        throw err;
      }
      throw new SafeOpenError("invalid-path", "path is not a regular file under root", {
        cause: err,
      });
    }
    throw err;
  }

  if (params.rejectHardlinks !== false && opened.stat.nlink > 1) {
    await opened.handle.close().catch(() => {});
    throw new SafeOpenError("invalid-path", "hardlinked path not allowed");
  }

  if (!isPathInside(rootWithSep, opened.realPath)) {
    await opened.handle.close().catch(() => {});
    throw new SafeOpenError("invalid-path", "path escapes root");
  }

  return opened;
}

export async function readLocalFileSafely(params: {
  filePath: string;
  maxBytes?: number;
}): Promise<SafeLocalReadResult> {
  const opened = await openVerifiedLocalFile(params.filePath);
  try {
    if (params.maxBytes !== undefined && opened.stat.size > params.maxBytes) {
      throw new SafeOpenError(
        "too-large",
        `file exceeds limit of ${params.maxBytes} bytes (got ${opened.stat.size})`,
      );
    }
    const buffer = await opened.handle.readFile();
    return { buffer, realPath: opened.realPath, stat: opened.stat };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

export async function writeFileWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  data: string | Buffer;
  encoding?: BufferEncoding;
  mkdir?: boolean;
}): Promise<void> {
  let rootReal: string;
  try {
    rootReal = await fs.realpath(params.rootDir);
  } catch (err) {
    if (isNotFoundPathError(err)) {
      throw new SafeOpenError("not-found", "root dir not found");
    }
    throw err;
  }
  const rootWithSep = ensureTrailingSep(rootReal);
  const resolved = path.resolve(rootWithSep, params.relativePath);
  if (!isPathInside(rootWithSep, resolved)) {
    throw new SafeOpenError("invalid-path", "path escapes root");
  }
  try {
    await assertNoPathAliasEscape({
      absolutePath: resolved,
      rootPath: rootReal,
      boundaryLabel: "root",
    });
  } catch (err) {
    throw new SafeOpenError("invalid-path", "path alias escape blocked", { cause: err });
  }
  if (params.mkdir !== false) {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
  }

  let ioPath = resolved;
  try {
    const resolvedRealPath = await fs.realpath(resolved);
    if (!isPathInside(rootWithSep, resolvedRealPath)) {
      throw new SafeOpenError("invalid-path", "path escapes root");
    }
    ioPath = resolvedRealPath;
  } catch (err) {
    if (err instanceof SafeOpenError) {
      throw err;
    }
    if (!isNotFoundPathError(err)) {
      throw err;
    }
  }

  let handle: FileHandle;
  try {
    handle = await fs.open(ioPath, OPEN_WRITE_FLAGS, 0o600);
  } catch (err) {
    if (isNotFoundPathError(err)) {
      throw new SafeOpenError("not-found", "file not found");
    }
    if (isSymlinkOpenError(err)) {
      throw new SafeOpenError("invalid-path", "symlink open blocked", { cause: err });
    }
    throw err;
  }

  try {
    const [stat, lstat] = await Promise.all([handle.stat(), fs.lstat(ioPath)]);
    if (lstat.isSymbolicLink() || !stat.isFile()) {
      throw new SafeOpenError("invalid-path", "path is not a regular file under root");
    }
    if (stat.nlink > 1) {
      throw new SafeOpenError("invalid-path", "hardlinked path not allowed");
    }
    if (!sameFileIdentity(stat, lstat)) {
      throw new SafeOpenError("path-mismatch", "path changed during write");
    }

    const realPath = await fs.realpath(ioPath);
    const realStat = await fs.stat(realPath);
    if (!sameFileIdentity(stat, realStat)) {
      throw new SafeOpenError("path-mismatch", "path mismatch");
    }
    if (realStat.nlink > 1) {
      throw new SafeOpenError("invalid-path", "hardlinked path not allowed");
    }
    if (!isPathInside(rootWithSep, realPath)) {
      throw new SafeOpenError("invalid-path", "path escapes root");
    }

    if (typeof params.data === "string") {
      await handle.writeFile(params.data, params.encoding ?? "utf8");
    } else {
      await handle.writeFile(params.data);
    }
  } finally {
    await handle.close().catch(() => {});
  }
}
