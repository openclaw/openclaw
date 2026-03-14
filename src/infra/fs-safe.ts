import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logWarn } from "../logger.js";
import { sameFileIdentity } from "./file-identity.js";
import { runPinnedWriteHelper } from "./fs-pinned-write-helper.js";
import { expandHomePrefix } from "./home-dir.js";
import { assertNoPathAliasEscape } from "./path-alias-guards.js";
import {
  hasNodeErrorCode,
  isNotFoundPathError,
  isPathInside,
  isSymlinkOpenError,
} from "./path-guards.js";

export type SafeOpenErrorCode =
  | "invalid-path"
  | "not-found"
  | "outside-workspace"
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
const OPEN_WRITE_EXISTING_FLAGS =
  fsConstants.O_WRONLY | (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
const OPEN_WRITE_CREATE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
const OPEN_APPEND_EXISTING_FLAGS =
  fsConstants.O_RDWR | fsConstants.O_APPEND | (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
const OPEN_APPEND_CREATE_FLAGS =
  fsConstants.O_RDWR |
  fsConstants.O_APPEND |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);

const ensureTrailingSep = (value: string) => (value.endsWith(path.sep) ? value : value + path.sep);

async function expandRelativePathWithHome(relativePath: string): Promise<string> {
  let home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  try {
    home = await fs.realpath(home);
  } catch {
    // If the home dir cannot be canonicalized, keep lexical expansion behavior.
  }
  return expandHomePrefix(relativePath, { home });
}

async function openVerifiedLocalFile(
  filePath: string,
  options?: {
    rejectHardlinks?: boolean;
  },
): Promise<SafeOpenResult> {
  // Reject directories before opening so we never surface EISDIR to callers (e.g. tool
  // results that get sent to messaging channels). See openclaw/openclaw#31186.
  try {
    const preStat = await fs.lstat(filePath);
    if (preStat.isDirectory()) {
      throw new SafeOpenError("not-file", "not a file");
    }
  } catch (err) {
    if (err instanceof SafeOpenError) {
      throw err;
    }
    // ENOENT and other lstat errors: fall through and let fs.open handle.
  }

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
    // Defensive: if open still throws EISDIR (e.g. race), sanitize so it never leaks.
    if (hasNodeErrorCode(err, "EISDIR")) {
      throw new SafeOpenError("not-file", "not a file");
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

async function resolvePathWithinRoot(params: {
  rootDir: string;
  relativePath: string;
}): Promise<{ rootReal: string; rootWithSep: string; resolved: string }> {
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
  const expanded = await expandRelativePathWithHome(params.relativePath);
  const resolved = path.resolve(rootWithSep, expanded);
  if (!isPathInside(rootWithSep, resolved)) {
    throw new SafeOpenError("outside-workspace", "file is outside workspace root");
  }
  return { rootReal, rootWithSep, resolved };
}

export async function openFileWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  rejectHardlinks?: boolean;
}): Promise<SafeOpenResult> {
  const { rootWithSep, resolved } = await resolvePathWithinRoot(params);

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
    throw new SafeOpenError("outside-workspace", "file is outside workspace root");
  }

  return opened;
}

export async function readFileWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  rejectHardlinks?: boolean;
  maxBytes?: number;
}): Promise<SafeLocalReadResult> {
  const opened = await openFileWithinRoot({
    rootDir: params.rootDir,
    relativePath: params.relativePath,
    rejectHardlinks: params.rejectHardlinks,
  });
  try {
    return await readOpenedFileSafely({ opened, maxBytes: params.maxBytes });
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

export async function readPathWithinRoot(params: {
  rootDir: string;
  filePath: string;
  rejectHardlinks?: boolean;
  maxBytes?: number;
}): Promise<SafeLocalReadResult> {
  const rootDir = path.resolve(params.rootDir);
  const candidatePath = path.isAbsolute(params.filePath)
    ? path.resolve(params.filePath)
    : path.resolve(rootDir, params.filePath);
  const relativePath = path.relative(rootDir, candidatePath);
  return await readFileWithinRoot({
    rootDir,
    relativePath,
    rejectHardlinks: params.rejectHardlinks,
    maxBytes: params.maxBytes,
  });
}

export function createRootScopedReadFile(params: {
  rootDir: string;
  rejectHardlinks?: boolean;
  maxBytes?: number;
}): (filePath: string) => Promise<Buffer> {
  const rootDir = path.resolve(params.rootDir);
  return async (filePath: string) => {
    const safeRead = await readPathWithinRoot({
      rootDir,
      filePath,
      rejectHardlinks: params.rejectHardlinks,
      maxBytes: params.maxBytes,
    });
    return safeRead.buffer;
  };
}

export async function readLocalFileSafely(params: {
  filePath: string;
  maxBytes?: number;
}): Promise<SafeLocalReadResult> {
  const opened = await openVerifiedLocalFile(params.filePath);
  try {
    return await readOpenedFileSafely({ opened, maxBytes: params.maxBytes });
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

async function readOpenedFileSafely(params: {
  opened: SafeOpenResult;
  maxBytes?: number;
}): Promise<SafeLocalReadResult> {
  if (params.maxBytes !== undefined && params.opened.stat.size > params.maxBytes) {
    throw new SafeOpenError(
      "too-large",
      `file exceeds limit of ${params.maxBytes} bytes (got ${params.opened.stat.size})`,
    );
  }
  const buffer = await params.opened.handle.readFile();
  return {
    buffer,
    realPath: params.opened.realPath,
    stat: params.opened.stat,
  };
}

export type SafeWritableOpenResult = {
  handle: FileHandle;
  createdForWrite: boolean;
  openedRealPath: string;
  openedStat: Stats;
};

function emitWriteBoundaryWarning(reason: string) {
  logWarn(`security: fs-safe write boundary warning (${reason})`);
}

function buildAtomicWriteTempPath(targetPath: string): string {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  return path.join(dir, `.${base}.${process.pid}.${randomUUID()}.tmp`);
}

async function writeTempFileForAtomicReplace(params: {
  tempPath: string;
  data: string | Buffer;
  encoding?: BufferEncoding;
  mode: number;
}): Promise<Stats> {
  const tempHandle = await fs.open(params.tempPath, OPEN_WRITE_CREATE_FLAGS, params.mode);
  try {
    if (typeof params.data === "string") {
      await tempHandle.writeFile(params.data, params.encoding ?? "utf8");
    } else {
      await tempHandle.writeFile(params.data);
    }
    return await tempHandle.stat();
  } finally {
    await tempHandle.close().catch(() => {});
  }
}

async function verifyAtomicWriteResult(params: {
  rootDir: string;
  targetPath: string;
  expectedIdentity: { dev: number | bigint; ino: number | bigint };
}): Promise<void> {
  const rootReal = await fs.realpath(params.rootDir);
  const rootWithSep = ensureTrailingSep(rootReal);
  const opened = await openVerifiedLocalFile(params.targetPath, { rejectHardlinks: true });
  try {
    if (!sameFileIdentity(opened.stat, params.expectedIdentity)) {
      throw new SafeOpenError("path-mismatch", "path changed during write");
    }
    if (!isPathInside(rootWithSep, opened.realPath)) {
      throw new SafeOpenError("outside-workspace", "file is outside workspace root");
    }
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

export async function resolveOpenedFileRealPathForHandle(
  handle: FileHandle,
  ioPath: string,
): Promise<string> {
  try {
    return await fs.realpath(ioPath);
  } catch (err) {
    if (!isNotFoundPathError(err)) {
      throw err;
    }
  }

  const fdCandidates =
    process.platform === "linux"
      ? [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]
      : process.platform === "win32"
        ? []
        : [`/dev/fd/${handle.fd}`];
  for (const fdPath of fdCandidates) {
    try {
      return await fs.realpath(fdPath);
    } catch {
      // try next fd path
    }
  }
  throw new SafeOpenError("path-mismatch", "unable to resolve opened file path");
}

export async function openWritableFileWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  mkdir?: boolean;
  mode?: number;
  truncateExisting?: boolean;
  append?: boolean;
}): Promise<SafeWritableOpenResult> {
  const { rootReal, rootWithSep, resolved } = await resolvePathWithinRoot(params);
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
      throw new SafeOpenError("outside-workspace", "file is outside workspace root");
    }
    ioPath = resolvedRealPath;
  } catch (err) {
    if (err instanceof SafeOpenError) {
      throw err;
    }
    if (!isNotFoundPathError(err)) {
      throw err;
    }
    // File doesn't exist yet (ENOENT). On Windows, O_NOFOLLOW is unavailable,
    // so open(O_CREAT) would follow directory junctions. Resolve the parent
    // directory to verify it is inside the workspace root before creating.
    if (!SUPPORTS_NOFOLLOW) {
      const parentDir = path.dirname(resolved);
      const parentReal = await fs.realpath(parentDir);
      if (!isPathInside(rootWithSep, parentReal) && parentReal !== rootReal) {
        throw new SafeOpenError(
          "outside-workspace",
          "parent directory resolves outside workspace root",
        );
      }
      ioPath = path.join(parentReal, path.basename(resolved));
    }
  }

  const fileMode = params.mode ?? 0o600;

  let handle: FileHandle;
  let createdForWrite = false;
  const existingFlags = params.append ? OPEN_APPEND_EXISTING_FLAGS : OPEN_WRITE_EXISTING_FLAGS;
  const createFlags = params.append ? OPEN_APPEND_CREATE_FLAGS : OPEN_WRITE_CREATE_FLAGS;
  try {
    try {
      handle = await fs.open(ioPath, existingFlags, fileMode);
    } catch (err) {
      if (!isNotFoundPathError(err)) {
        throw err;
      }
      handle = await fs.open(ioPath, createFlags, fileMode);
      createdForWrite = true;
    }
  } catch (err) {
    if (isNotFoundPathError(err)) {
      throw new SafeOpenError("not-found", "file not found");
    }
    if (isSymlinkOpenError(err)) {
      throw new SafeOpenError("invalid-path", "symlink open blocked", { cause: err });
    }
    throw err;
  }

  let openedRealPath: string | null = null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new SafeOpenError("invalid-path", "path is not a regular file under root");
    }
    if (stat.nlink > 1) {
      throw new SafeOpenError("invalid-path", "hardlinked path not allowed");
    }

    try {
      const lstat = await fs.lstat(ioPath);
      if (lstat.isSymbolicLink() || !lstat.isFile()) {
        throw new SafeOpenError("invalid-path", "path is not a regular file under root");
      }
      if (!sameFileIdentity(stat, lstat)) {
        throw new SafeOpenError("path-mismatch", "path changed during write");
      }
    } catch (err) {
      if (!isNotFoundPathError(err)) {
        throw err;
      }
    }

    const realPath = await resolveOpenedFileRealPathForHandle(handle, ioPath);
    openedRealPath = realPath;
    const realStat = await fs.stat(realPath);
    if (!sameFileIdentity(stat, realStat)) {
      throw new SafeOpenError("path-mismatch", "path mismatch");
    }
    if (realStat.nlink > 1) {
      throw new SafeOpenError("invalid-path", "hardlinked path not allowed");
    }
    if (!isPathInside(rootWithSep, realPath)) {
      throw new SafeOpenError("outside-workspace", "file is outside workspace root");
    }

    // Truncate only after boundary and identity checks complete. This avoids
    // irreversible side effects if a symlink target changes before validation.
    if (params.append !== true && params.truncateExisting !== false && !createdForWrite) {
      await handle.truncate(0);
    }
    return {
      handle,
      createdForWrite,
      openedRealPath: realPath,
      openedStat: stat,
    };
  } catch (err) {
    const cleanupCreatedPath = createdForWrite && err instanceof SafeOpenError;
    const cleanupPath = openedRealPath ?? ioPath;
    await handle.close().catch(() => {});
    if (cleanupCreatedPath) {
      await fs.rm(cleanupPath, { force: true }).catch(() => {});
    }
    throw err;
  }
}

export async function appendFileWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  data: string | Buffer;
  encoding?: BufferEncoding;
  mkdir?: boolean;
  prependNewlineIfNeeded?: boolean;
}): Promise<void> {
  const target = await openWritableFileWithinRoot({
    rootDir: params.rootDir,
    relativePath: params.relativePath,
    mkdir: params.mkdir,
    truncateExisting: false,
    append: true,
  });
  try {
    let prefix = "";
    if (
      params.prependNewlineIfNeeded === true &&
      !target.createdForWrite &&
      target.openedStat.size > 0 &&
      ((typeof params.data === "string" && !params.data.startsWith("\n")) ||
        (Buffer.isBuffer(params.data) && params.data.length > 0 && params.data[0] !== 0x0a))
    ) {
      const lastByte = Buffer.alloc(1);
      const { bytesRead } = await target.handle.read(lastByte, 0, 1, target.openedStat.size - 1);
      if (bytesRead === 1 && lastByte[0] !== 0x0a) {
        prefix = "\n";
      }
    }

    if (typeof params.data === "string") {
      await target.handle.appendFile(`${prefix}${params.data}`, params.encoding ?? "utf8");
      return;
    }

    const payload =
      prefix.length > 0 ? Buffer.concat([Buffer.from(prefix, "utf8"), params.data]) : params.data;
    await target.handle.appendFile(payload);
  } finally {
    await target.handle.close().catch(() => {});
  }
}

export async function writeFileWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  data: string | Buffer;
  encoding?: BufferEncoding;
  mkdir?: boolean;
}): Promise<void> {
  if (process.platform === "win32") {
    await writeFileWithinRootLegacy(params);
    return;
  }

  const pinned = await resolvePinnedWriteTargetWithinRoot({
    rootDir: params.rootDir,
    relativePath: params.relativePath,
  });

  const identity = await runPinnedWriteHelper({
    rootPath: pinned.rootReal,
    relativeParentPath: pinned.relativeParentPath,
    basename: pinned.basename,
    mkdir: params.mkdir !== false,
    mode: pinned.mode,
    input: {
      kind: "buffer",
      data: params.data,
      encoding: params.encoding,
    },
  }).catch((error) => {
    throw normalizePinnedWriteError(error);
  });

  try {
    await verifyAtomicWriteResult({
      rootDir: params.rootDir,
      targetPath: pinned.targetPath,
      expectedIdentity: identity,
    });
  } catch (err) {
    emitWriteBoundaryWarning(`post-write verification failed: ${String(err)}`);
    throw err;
  }
}

export async function copyFileWithinRoot(params: {
  sourcePath: string;
  rootDir: string;
  relativePath: string;
  maxBytes?: number;
  mkdir?: boolean;
  rejectSourceHardlinks?: boolean;
}): Promise<void> {
  const source = await openVerifiedLocalFile(params.sourcePath, {
    rejectHardlinks: params.rejectSourceHardlinks,
  });
  if (params.maxBytes !== undefined && source.stat.size > params.maxBytes) {
    await source.handle.close().catch(() => {});
    throw new SafeOpenError(
      "too-large",
      `file exceeds limit of ${params.maxBytes} bytes (got ${source.stat.size})`,
    );
  }

  try {
    if (process.platform === "win32") {
      await copyFileWithinRootLegacy(params, source);
      return;
    }

    const pinned = await resolvePinnedWriteTargetWithinRoot({
      rootDir: params.rootDir,
      relativePath: params.relativePath,
    });
    const sourceStream = source.handle.createReadStream();
    const identity = await runPinnedWriteHelper({
      rootPath: pinned.rootReal,
      relativeParentPath: pinned.relativeParentPath,
      basename: pinned.basename,
      mkdir: params.mkdir !== false,
      mode: pinned.mode,
      input: {
        kind: "stream",
        stream: sourceStream,
      },
    }).catch((error) => {
      throw normalizePinnedWriteError(error);
    });
    try {
      await verifyAtomicWriteResult({
        rootDir: params.rootDir,
        targetPath: pinned.targetPath,
        expectedIdentity: identity,
      });
    } catch (err) {
      emitWriteBoundaryWarning(`post-copy verification failed: ${String(err)}`);
      throw err;
    }
  } finally {
    await source.handle.close().catch(() => {});
  }
}

export async function writeFileFromPathWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  sourcePath: string;
  mkdir?: boolean;
}): Promise<void> {
  await copyFileWithinRoot({
    sourcePath: params.sourcePath,
    rootDir: params.rootDir,
    relativePath: params.relativePath,
    mkdir: params.mkdir,
    rejectSourceHardlinks: true,
  });
}

async function resolvePinnedWriteTargetWithinRoot(params: {
  rootDir: string;
  relativePath: string;
}): Promise<{
  rootReal: string;
  targetPath: string;
  relativeParentPath: string;
  basename: string;
  mode: number;
}> {
  const { rootReal, rootWithSep, resolved } = await resolvePathWithinRoot(params);
  try {
    await assertNoPathAliasEscape({
      absolutePath: resolved,
      rootPath: rootReal,
      boundaryLabel: "root",
    });
  } catch (err) {
    throw new SafeOpenError("invalid-path", "path alias escape blocked", { cause: err });
  }

  const relativeResolved = path.relative(rootReal, resolved);
  if (relativeResolved.startsWith("..") || path.isAbsolute(relativeResolved)) {
    throw new SafeOpenError("outside-workspace", "file is outside workspace root");
  }
  const relativePosix = relativeResolved
    ? relativeResolved.split(path.sep).join(path.posix.sep)
    : "";
  const basename = path.posix.basename(relativePosix);
  if (!basename || basename === "." || basename === "/") {
    throw new SafeOpenError("invalid-path", "invalid target path");
  }
  let mode = 0o600;
  try {
    const opened = await openFileWithinRoot({
      rootDir: params.rootDir,
      relativePath: params.relativePath,
      rejectHardlinks: true,
    });
    try {
      mode = opened.stat.mode & 0o777;
      if (!isPathInside(rootWithSep, opened.realPath)) {
        throw new SafeOpenError("outside-workspace", "file is outside workspace root");
      }
    } finally {
      await opened.handle.close().catch(() => {});
    }
  } catch (err) {
    if (!(err instanceof SafeOpenError) || err.code !== "not-found") {
      throw err;
    }
  }

  return {
    rootReal,
    targetPath: resolved,
    relativeParentPath:
      path.posix.dirname(relativePosix) === "." ? "" : path.posix.dirname(relativePosix),
    basename,
    mode: mode || 0o600,
  };
}

function normalizePinnedWriteError(error: unknown): Error {
  if (error instanceof SafeOpenError) {
    return error;
  }
  return new SafeOpenError("invalid-path", "path is not a regular file under root", {
    cause: error instanceof Error ? error : undefined,
  });
}

async function writeFileWithinRootLegacy(params: {
  rootDir: string;
  relativePath: string;
  data: string | Buffer;
  encoding?: BufferEncoding;
  mkdir?: boolean;
}): Promise<void> {
  const target = await openWritableFileWithinRoot({
    rootDir: params.rootDir,
    relativePath: params.relativePath,
    mkdir: params.mkdir,
    truncateExisting: false,
  });
  const destinationPath = target.openedRealPath;
  const targetMode = target.openedStat.mode & 0o777;
  await target.handle.close().catch(() => {});
  let tempPath: string | null = null;
  try {
    tempPath = buildAtomicWriteTempPath(destinationPath);
    const writtenStat = await writeTempFileForAtomicReplace({
      tempPath,
      data: params.data,
      encoding: params.encoding,
      mode: targetMode || 0o600,
    });
    await fs.rename(tempPath, destinationPath);
    tempPath = null;
    try {
      await verifyAtomicWriteResult({
        rootDir: params.rootDir,
        targetPath: destinationPath,
        expectedIdentity: writtenStat,
      });
    } catch (err) {
      emitWriteBoundaryWarning(`post-write verification failed: ${String(err)}`);
      throw err;
    }
  } finally {
    if (tempPath) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
  }
}

async function copyFileWithinRootLegacy(
  params: {
    sourcePath: string;
    rootDir: string;
    relativePath: string;
    maxBytes?: number;
    mkdir?: boolean;
    rejectSourceHardlinks?: boolean;
  },
  source: SafeOpenResult,
): Promise<void> {
  let target: SafeWritableOpenResult | null = null;
  let sourceClosedByStream = false;
  let targetClosedByUs = false;
  let tempHandle: FileHandle | null = null;
  let tempPath: string | null = null;
  let tempClosedByStream = false;
  try {
    target = await openWritableFileWithinRoot({
      rootDir: params.rootDir,
      relativePath: params.relativePath,
      mkdir: params.mkdir,
      truncateExisting: false,
    });
    const destinationPath = target.openedRealPath;
    const targetMode = target.openedStat.mode & 0o777;
    await target.handle.close().catch(() => {});
    targetClosedByUs = true;

    tempPath = buildAtomicWriteTempPath(destinationPath);
    tempHandle = await fs.open(tempPath, OPEN_WRITE_CREATE_FLAGS, targetMode || 0o600);
    const sourceStream = source.handle.createReadStream();
    const targetStream = tempHandle.createWriteStream();
    sourceStream.once("close", () => {
      sourceClosedByStream = true;
    });
    targetStream.once("close", () => {
      tempClosedByStream = true;
    });
    await import("node:stream/promises").then(({ pipeline }) =>
      pipeline(sourceStream, targetStream),
    );
    const writtenStat = await fs.stat(tempPath);
    if (!tempClosedByStream) {
      await tempHandle.close().catch(() => {});
      tempClosedByStream = true;
    }
    tempHandle = null;
    await fs.rename(tempPath, destinationPath);
    tempPath = null;
    try {
      await verifyAtomicWriteResult({
        rootDir: params.rootDir,
        targetPath: destinationPath,
        expectedIdentity: writtenStat,
      });
    } catch (err) {
      emitWriteBoundaryWarning(`post-copy verification failed: ${String(err)}`);
      throw err;
    }
  } catch (err) {
    if (target?.createdForWrite) {
      await fs.rm(target.openedRealPath, { force: true }).catch(() => {});
    }
    throw err;
  } finally {
    if (tempPath) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
    if (!sourceClosedByStream) {
      await source.handle.close().catch(() => {});
    }
    if (tempHandle && !tempClosedByStream) {
      await tempHandle.close().catch(() => {});
    }
    if (target && !targetClosedByUs) {
      await target.handle.close().catch(() => {});
    }
  }
}
