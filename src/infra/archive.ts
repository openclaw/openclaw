import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import JSZip from "jszip";
import * as tar from "tar";
import {
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "./archive-path.js";
import { sameFileIdentity } from "./file-identity.js";
import { openFileWithinRoot, openWritableFileWithinRoot, SafeOpenError } from "./fs-safe.js";
import { isNotFoundPathError, isPathInside } from "./path-guards.js";

export type ArchiveKind = "tar" | "zip";

export type ArchiveLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type ArchiveExtractLimits = {
  /**
   * Max archive file bytes (compressed).
   */
  maxArchiveBytes?: number;
  /** Max number of extracted entries (files + dirs). */
  maxEntries?: number;
  /** Max extracted bytes (sum of all files). */
  maxExtractedBytes?: number;
  /** Max extracted bytes for a single file entry. */
  maxEntryBytes?: number;
};

export type ArchiveSecurityErrorCode =
  | "destination-not-directory"
  | "destination-symlink"
  | "destination-symlink-traversal";

export class ArchiveSecurityError extends Error {
  code: ArchiveSecurityErrorCode;

  constructor(code: ArchiveSecurityErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "ArchiveSecurityError";
  }
}

/** @internal */
export const DEFAULT_MAX_ARCHIVE_BYTES_ZIP = 256 * 1024 * 1024;
/** @internal */
export const DEFAULT_MAX_ENTRIES = 50_000;
/** @internal */
export const DEFAULT_MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
/** @internal */
export const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024 * 1024;

const ERROR_ARCHIVE_SIZE_EXCEEDS_LIMIT = "archive size exceeds limit";
const ERROR_ARCHIVE_ENTRY_COUNT_EXCEEDS_LIMIT = "archive entry count exceeds limit";
const ERROR_ARCHIVE_ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT =
  "archive entry extracted size exceeds limit";
const ERROR_ARCHIVE_EXTRACTED_SIZE_EXCEEDS_LIMIT = "archive extracted size exceeds limit";
const ERROR_ARCHIVE_ENTRY_TRAVERSES_SYMLINK = "archive entry traverses symlink in destination";
const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in fsConstants;
const OPEN_WRITE_CREATE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);

const TAR_SUFFIXES = [".tgz", ".tar.gz", ".tar"];

export function resolveArchiveKind(filePath: string): ArchiveKind | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".zip")) {
    return "zip";
  }
  if (TAR_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return "tar";
  }
  return null;
}

export async function resolvePackedRootDir(extractDir: string): Promise<string> {
  const direct = path.join(extractDir, "package");
  try {
    const stat = await fs.stat(direct);
    if (stat.isDirectory()) {
      return direct;
    }
  } catch {
    // ignore
  }

  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (dirs.length !== 1) {
    throw new Error(`unexpected archive layout (dirs: ${dirs.join(", ")})`);
  }
  const onlyDir = dirs[0];
  if (!onlyDir) {
    throw new Error("unexpected archive layout (no package dir found)");
  }
  return path.join(extractDir, onlyDir);
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

type ResolvedArchiveExtractLimits = Required<ArchiveExtractLimits>;

function clampLimit(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const v = Math.floor(value);
  return v > 0 ? v : undefined;
}

function resolveExtractLimits(limits?: ArchiveExtractLimits): ResolvedArchiveExtractLimits {
  // Defaults: defensive, but should not break normal installs.
  return {
    maxArchiveBytes: clampLimit(limits?.maxArchiveBytes) ?? DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
    maxEntries: clampLimit(limits?.maxEntries) ?? DEFAULT_MAX_ENTRIES,
    maxExtractedBytes: clampLimit(limits?.maxExtractedBytes) ?? DEFAULT_MAX_EXTRACTED_BYTES,
    maxEntryBytes: clampLimit(limits?.maxEntryBytes) ?? DEFAULT_MAX_ENTRY_BYTES,
  };
}

function assertArchiveEntryCountWithinLimit(
  entryCount: number,
  limits: ResolvedArchiveExtractLimits,
) {
  if (entryCount > limits.maxEntries) {
    throw new Error(ERROR_ARCHIVE_ENTRY_COUNT_EXCEEDS_LIMIT);
  }
}

function createByteBudgetTracker(limits: ResolvedArchiveExtractLimits): {
  startEntry: () => void;
  addBytes: (bytes: number) => void;
  addEntrySize: (size: number) => void;
} {
  let entryBytes = 0;
  let extractedBytes = 0;

  const addBytes = (bytes: number) => {
    const b = Math.max(0, Math.floor(bytes));
    if (b === 0) {
      return;
    }
    entryBytes += b;
    if (entryBytes > limits.maxEntryBytes) {
      throw new Error(ERROR_ARCHIVE_ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
    }
    extractedBytes += b;
    if (extractedBytes > limits.maxExtractedBytes) {
      throw new Error(ERROR_ARCHIVE_EXTRACTED_SIZE_EXCEEDS_LIMIT);
    }
  };

  return {
    startEntry() {
      entryBytes = 0;
    },
    addBytes,
    addEntrySize(size: number) {
      const s = Math.max(0, Math.floor(size));
      if (s > limits.maxEntryBytes) {
        throw new Error(ERROR_ARCHIVE_ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
      }
      // Note: tar budgets are based on the header-declared size.
      addBytes(s);
    },
  };
}

function createExtractBudgetTransform(params: {
  onChunkBytes: (bytes: number) => void;
}): Transform {
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk as Uint8Array);
        params.onChunkBytes(buf.byteLength);
        callback(null, buf);
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
}

function symlinkTraversalError(originalPath: string): ArchiveSecurityError {
  return new ArchiveSecurityError(
    "destination-symlink-traversal",
    `${ERROR_ARCHIVE_ENTRY_TRAVERSES_SYMLINK}: ${originalPath}`,
  );
}

async function assertDestinationDirReady(destDir: string): Promise<string> {
  const stat = await fs.lstat(destDir);
  if (stat.isSymbolicLink()) {
    throw new ArchiveSecurityError("destination-symlink", "archive destination is a symlink");
  }
  if (!stat.isDirectory()) {
    throw new ArchiveSecurityError(
      "destination-not-directory",
      "archive destination is not a directory",
    );
  }
  return await fs.realpath(destDir);
}

async function assertNoSymlinkTraversal(params: {
  rootDir: string;
  relPath: string;
  originalPath: string;
}): Promise<void> {
  const parts = params.relPath.split("/").filter(Boolean);
  let current = path.resolve(params.rootDir);
  for (const part of parts) {
    current = path.join(current, part);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(current);
    } catch (err) {
      if (isNotFoundPathError(err)) {
        continue;
      }
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw symlinkTraversalError(params.originalPath);
    }
  }
}

async function assertResolvedInsideDestination(params: {
  destinationRealDir: string;
  targetPath: string;
  originalPath: string;
}): Promise<void> {
  let resolved: string;
  try {
    resolved = await fs.realpath(params.targetPath);
  } catch (err) {
    if (isNotFoundPathError(err)) {
      return;
    }
    throw err;
  }
  if (!isPathInside(params.destinationRealDir, resolved)) {
    throw symlinkTraversalError(params.originalPath);
  }
}

type OpenZipOutputFileResult = {
  handle: FileHandle;
  createdForWrite: boolean;
  openedRealPath: string;
  openedStat: Stats;
};

async function openZipOutputFile(params: {
  relPath: string;
  originalPath: string;
  destinationRealDir: string;
}): Promise<OpenZipOutputFileResult> {
  try {
    return await openWritableFileWithinRoot({
      rootDir: params.destinationRealDir,
      relativePath: params.relPath,
      mkdir: false,
      mode: 0o666,
    });
  } catch (err) {
    if (
      err instanceof SafeOpenError &&
      (err.code === "invalid-path" ||
        err.code === "outside-workspace" ||
        err.code === "path-mismatch")
    ) {
      throw symlinkTraversalError(params.originalPath);
    }
    throw err;
  }
}

async function cleanupPartialRegularFile(filePath: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath);
  } catch (err) {
    if (isNotFoundPathError(err)) {
      return;
    }
    throw err;
  }
  if (stat.isFile()) {
    await fs.unlink(filePath).catch(() => undefined);
  }
}

function buildArchiveAtomicTempPath(targetPath: string): string {
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
}

async function verifyZipWriteResult(params: {
  destinationRealDir: string;
  relPath: string;
  expectedStat: Stats;
}): Promise<string> {
  const opened = await openFileWithinRoot({
    rootDir: params.destinationRealDir,
    relativePath: params.relPath,
    rejectHardlinks: true,
  });
  try {
    if (!sameFileIdentity(opened.stat, params.expectedStat)) {
      throw new SafeOpenError("path-mismatch", "path changed during zip extract");
    }
    return opened.realPath;
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

type ZipEntry = {
  name: string;
  dir: boolean;
  unixPermissions?: number;
  nodeStream?: () => NodeJS.ReadableStream;
  async: (type: "nodebuffer") => Promise<Buffer>;
};

type ZipExtractBudget = ReturnType<typeof createByteBudgetTracker>;

async function readZipEntryStream(entry: ZipEntry): Promise<NodeJS.ReadableStream> {
  if (typeof entry.nodeStream === "function") {
    return entry.nodeStream();
  }
  // Old JSZip: fall back to buffering, but still extract via a stream.
  const buf = await entry.async("nodebuffer");
  return Readable.from(buf);
}

function resolveZipOutputPath(params: {
  entryPath: string;
  strip: number;
  destinationDir: string;
}): { relPath: string; outPath: string } | null {
  validateArchiveEntryPath(params.entryPath);
  const relPath = stripArchivePath(params.entryPath, params.strip);
  if (!relPath) {
    return null;
  }
  validateArchiveEntryPath(relPath);
  return {
    relPath,
    outPath: resolveArchiveOutputPath({
      rootDir: params.destinationDir,
      relPath,
      originalPath: params.entryPath,
    }),
  };
}

async function prepareZipOutputPath(params: {
  destinationDir: string;
  destinationRealDir: string;
  relPath: string;
  outPath: string;
  originalPath: string;
  isDirectory: boolean;
}): Promise<void> {
  await assertNoSymlinkTraversal({
    rootDir: params.destinationDir,
    relPath: params.relPath,
    originalPath: params.originalPath,
  });

  if (params.isDirectory) {
    await fs.mkdir(params.outPath, { recursive: true });
    await assertResolvedInsideDestination({
      destinationRealDir: params.destinationRealDir,
      targetPath: params.outPath,
      originalPath: params.originalPath,
    });
    return;
  }

  const parentDir = path.dirname(params.outPath);
  await fs.mkdir(parentDir, { recursive: true });
  await assertResolvedInsideDestination({
    destinationRealDir: params.destinationRealDir,
    targetPath: parentDir,
    originalPath: params.originalPath,
  });
}

async function writeZipFileEntry(params: {
  entry: ZipEntry;
  relPath: string;
  destinationRealDir: string;
  budget: ZipExtractBudget;
}): Promise<void> {
  const opened = await openZipOutputFile({
    relPath: params.relPath,
    originalPath: params.entry.name,
    destinationRealDir: params.destinationRealDir,
  });
  params.budget.startEntry();
  const readable = await readZipEntryStream(params.entry);
  const destinationPath = opened.openedRealPath;
  const targetMode = opened.openedStat.mode & 0o777;
  await opened.handle.close().catch(() => undefined);

  let tempHandle: FileHandle | null = null;
  let tempPath: string | null = null;
  let tempStat: Stats | null = null;
  let handleClosedByStream = false;

  try {
    tempPath = buildArchiveAtomicTempPath(destinationPath);
    tempHandle = await fs.open(tempPath, OPEN_WRITE_CREATE_FLAGS, targetMode || 0o666);
    const writable = tempHandle.createWriteStream();
    writable.once("close", () => {
      handleClosedByStream = true;
    });

    await pipeline(
      readable,
      createExtractBudgetTransform({ onChunkBytes: params.budget.addBytes }),
      writable,
    );
    tempStat = await fs.stat(tempPath);
    if (!tempStat) {
      throw new Error("zip temp write did not produce file metadata");
    }
    if (!handleClosedByStream) {
      await tempHandle.close().catch(() => undefined);
      handleClosedByStream = true;
    }
    tempHandle = null;
    await fs.rename(tempPath, destinationPath);
    tempPath = null;
    const verifiedPath = await verifyZipWriteResult({
      destinationRealDir: params.destinationRealDir,
      relPath: params.relPath,
      expectedStat: tempStat,
    });

    // Best-effort permission restore for zip entries created on unix.
    if (typeof params.entry.unixPermissions === "number") {
      const mode = params.entry.unixPermissions & 0o777;
      if (mode !== 0) {
        await fs.chmod(verifiedPath, mode).catch(() => undefined);
      }
    }
  } catch (err) {
    if (tempPath) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    } else {
      await cleanupPartialRegularFile(destinationPath).catch(() => undefined);
    }
    if (err instanceof SafeOpenError) {
      throw symlinkTraversalError(params.entry.name);
    }
    throw err;
  } finally {
    if (tempHandle && !handleClosedByStream) {
      await tempHandle.close().catch(() => undefined);
    }
  }
}

async function extractZip(params: {
  archivePath: string;
  destDir: string;
  stripComponents?: number;
  limits?: ArchiveExtractLimits;
}): Promise<void> {
  const limits = resolveExtractLimits(params.limits);
  const destinationRealDir = await assertDestinationDirReady(params.destDir);
  const stat = await fs.stat(params.archivePath);
  if (stat.size > limits.maxArchiveBytes) {
    throw new Error(ERROR_ARCHIVE_SIZE_EXCEEDS_LIMIT);
  }

  const buffer = await fs.readFile(params.archivePath);
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files) as ZipEntry[];
  const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));

  assertArchiveEntryCountWithinLimit(entries.length, limits);

  const budget = createByteBudgetTracker(limits);

  for (const entry of entries) {
    const output = resolveZipOutputPath({
      entryPath: entry.name,
      strip,
      destinationDir: params.destDir,
    });
    if (!output) {
      continue;
    }

    await prepareZipOutputPath({
      destinationDir: params.destDir,
      destinationRealDir,
      relPath: output.relPath,
      outPath: output.outPath,
      originalPath: entry.name,
      isDirectory: entry.dir,
    });
    if (entry.dir) {
      continue;
    }

    await writeZipFileEntry({
      entry,
      relPath: output.relPath,
      destinationRealDir,
      budget,
    });
  }
}

export type TarEntryInfo = { path: string; type: string; size: number };

const BLOCKED_TAR_ENTRY_TYPES = new Set([
  "SymbolicLink",
  "Link",
  "BlockDevice",
  "CharacterDevice",
  "FIFO",
  "Socket",
]);

function readTarEntryInfo(entry: unknown): TarEntryInfo {
  const p =
    typeof entry === "object" && entry !== null && "path" in entry
      ? String((entry as { path: unknown }).path)
      : "";
  const t =
    typeof entry === "object" && entry !== null && "type" in entry
      ? String((entry as { type: unknown }).type)
      : "";
  const s =
    typeof entry === "object" &&
    entry !== null &&
    "size" in entry &&
    typeof (entry as { size?: unknown }).size === "number" &&
    Number.isFinite((entry as { size: number }).size)
      ? Math.max(0, Math.floor((entry as { size: number }).size))
      : 0;
  return { path: p, type: t, size: s };
}

export function createTarEntrySafetyChecker(params: {
  rootDir: string;
  stripComponents?: number;
  limits?: ArchiveExtractLimits;
  escapeLabel?: string;
}): (entry: TarEntryInfo) => void {
  const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));
  const limits = resolveExtractLimits(params.limits);
  let entryCount = 0;
  const budget = createByteBudgetTracker(limits);

  return (entry: TarEntryInfo) => {
    validateArchiveEntryPath(entry.path, { escapeLabel: params.escapeLabel });

    const relPath = stripArchivePath(entry.path, strip);
    if (!relPath) {
      return;
    }
    validateArchiveEntryPath(relPath, { escapeLabel: params.escapeLabel });
    resolveArchiveOutputPath({
      rootDir: params.rootDir,
      relPath,
      originalPath: entry.path,
      escapeLabel: params.escapeLabel,
    });

    if (BLOCKED_TAR_ENTRY_TYPES.has(entry.type)) {
      throw new Error(`tar entry is a link: ${entry.path}`);
    }

    entryCount += 1;
    assertArchiveEntryCountWithinLimit(entryCount, limits);
    budget.addEntrySize(entry.size);
  };
}

export async function extractArchive(params: {
  archivePath: string;
  destDir: string;
  timeoutMs: number;
  kind?: ArchiveKind;
  stripComponents?: number;
  tarGzip?: boolean;
  limits?: ArchiveExtractLimits;
  logger?: ArchiveLogger;
}): Promise<void> {
  const kind = params.kind ?? resolveArchiveKind(params.archivePath);
  if (!kind) {
    throw new Error(`unsupported archive: ${params.archivePath}`);
  }

  const label = kind === "zip" ? "extract zip" : "extract tar";
  if (kind === "tar") {
    const limits = resolveExtractLimits(params.limits);
    const stat = await fs.stat(params.archivePath);
    if (stat.size > limits.maxArchiveBytes) {
      throw new Error(ERROR_ARCHIVE_SIZE_EXCEEDS_LIMIT);
    }

    const checkTarEntrySafety = createTarEntrySafetyChecker({
      rootDir: params.destDir,
      stripComponents: params.stripComponents,
      limits,
    });
    await withTimeout(
      tar.x({
        file: params.archivePath,
        cwd: params.destDir,
        strip: Math.max(0, Math.floor(params.stripComponents ?? 0)),
        gzip: params.tarGzip,
        preservePaths: false,
        strict: true,
        onReadEntry(entry) {
          try {
            checkTarEntrySafety(readTarEntryInfo(entry));
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            // Node's EventEmitter calls listeners with `this` bound to the
            // emitter (tar.Unpack), which exposes Parser.abort().
            const emitter = this as unknown as { abort?: (error: Error) => void };
            emitter.abort?.(error);
          }
        },
      }),
      params.timeoutMs,
      label,
    );
    return;
  }

  await withTimeout(
    extractZip({
      archivePath: params.archivePath,
      destDir: params.destDir,
      stripComponents: params.stripComponents,
      limits: params.limits,
    }),
    params.timeoutMs,
    label,
  );
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}
