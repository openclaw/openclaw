import JSZip from "jszip";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";

export type ArchiveKind = "tar" | "zip";

export type ArchiveLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type ArchiveExtractLimits = {
  /**
   * Max archive file bytes (compressed). Primarily protects zip extraction
   * because we currently read the whole archive into memory for parsing.
   */
  maxArchiveBytes?: number;
  /** Max number of extracted entries (files + dirs). */
  maxEntries?: number;
  /** Max extracted bytes (sum of all files). */
  maxExtractedBytes?: number;
  /** Max extracted bytes for a single file entry. */
  maxEntryBytes?: number;
};

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

function resolveSafeBaseDir(destDir: string): string {
  const resolved = path.resolve(destDir);
  return resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
}

function normalizeArchivePath(raw: string): string {
  // Archives may contain Windows separators; treat them as separators.
  return raw.replaceAll("\\", "/");
}

function isWindowsDrivePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p);
}

function validateArchiveEntryPath(entryPath: string): void {
  if (!entryPath || entryPath === "." || entryPath === "./") {
    return;
  }
  if (isWindowsDrivePath(entryPath)) {
    throw new Error(`archive entry uses a drive path: ${entryPath}`);
  }
  const normalized = path.posix.normalize(normalizeArchivePath(entryPath));
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`archive entry escapes destination: ${entryPath}`);
  }
  if (path.posix.isAbsolute(normalized) || normalized.startsWith("//")) {
    throw new Error(`archive entry is absolute: ${entryPath}`);
  }
}

function stripArchivePath(entryPath: string, stripComponents: number): string | null {
  const raw = normalizeArchivePath(entryPath);
  if (!raw || raw === "." || raw === "./") {
    return null;
  }

  // Important: mimic tar --strip-components semantics (raw segments before
  // normalization) so strip-induced escapes like "a/../b" are not hidden.
  const parts = raw.split("/").filter((part) => part.length > 0 && part !== ".");
  const strip = Math.max(0, Math.floor(stripComponents));
  const stripped = strip === 0 ? parts.join("/") : parts.slice(strip).join("/");
  const result = path.posix.normalize(stripped);
  if (!result || result === "." || result === "./") {
    return null;
  }
  return result;
}

function resolveCheckedOutPath(destDir: string, relPath: string, original: string): string {
  const safeBase = resolveSafeBaseDir(destDir);
  const outPath = path.resolve(destDir, relPath);
  if (!outPath.startsWith(safeBase)) {
    throw new Error(`archive entry escapes destination: ${original}`);
  }
  return outPath;
}

function clampLimit(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const v = Math.floor(value);
  return v > 0 ? v : undefined;
}

function resolveExtractLimits(limits?: ArchiveExtractLimits): Required<ArchiveExtractLimits> {
  // Defaults: defensive, but should not break normal installs.
  return {
    maxArchiveBytes: clampLimit(limits?.maxArchiveBytes) ?? 256 * 1024 * 1024,
    maxEntries: clampLimit(limits?.maxEntries) ?? 50_000,
    maxExtractedBytes: clampLimit(limits?.maxExtractedBytes) ?? 512 * 1024 * 1024,
    maxEntryBytes: clampLimit(limits?.maxEntryBytes) ?? 256 * 1024 * 1024,
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

async function extractZip(params: {
  archivePath: string;
  destDir: string;
  stripComponents?: number;
  limits?: ArchiveExtractLimits;
}): Promise<void> {
  const limits = resolveExtractLimits(params.limits);
  const stat = await fs.stat(params.archivePath);
  if (stat.size > limits.maxArchiveBytes) {
    throw new Error("archive size exceeds limit");
  }

  const buffer = await fs.readFile(params.archivePath);
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files);
  const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));

  if (entries.length > limits.maxEntries) {
    throw new Error("archive entry count exceeds limit");
  }

  let extractedBytes = 0;

  for (const entry of entries) {
    validateArchiveEntryPath(entry.name);

    const relPath = stripArchivePath(entry.name, strip);
    if (!relPath) {
      continue;
    }
    validateArchiveEntryPath(relPath);

    const outPath = resolveCheckedOutPath(params.destDir, relPath, entry.name);
    if (entry.dir) {
      await fs.mkdir(outPath, { recursive: true });
      continue;
    }

    await fs.mkdir(path.dirname(outPath), { recursive: true });
    let entryBytes = 0;
    const onChunkBytes = (bytes: number) => {
      entryBytes += bytes;
      if (entryBytes > limits.maxEntryBytes) {
        throw new Error("archive entry extracted size exceeds limit");
      }
      extractedBytes += bytes;
      if (extractedBytes > limits.maxExtractedBytes) {
        throw new Error("archive extracted size exceeds limit");
      }
    };

    const readable =
      typeof entry.nodeStream === "function"
        ? (entry.nodeStream() as unknown)
        : await entry.async("nodebuffer");

    try {
      if (readable instanceof Buffer) {
        onChunkBytes(readable.byteLength);
        await fs.writeFile(outPath, readable);
      } else {
        await pipeline(
          readable as NodeJS.ReadableStream,
          createExtractBudgetTransform({ onChunkBytes }),
          createWriteStream(outPath),
        );
      }
    } catch (err) {
      await fs.unlink(outPath).catch(() => undefined);
      throw err;
    }

    // Best-effort permission restore for zip entries created on unix.
    if (typeof entry.unixPermissions === "number") {
      const mode = entry.unixPermissions & 0o777;
      if (mode !== 0) {
        await fs.chmod(outPath, mode).catch(() => undefined);
      }
    }
  }
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
    const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));
    const limits = resolveExtractLimits(params.limits);
    let entryCount = 0;
    let extractedBytes = 0;
    await withTimeout(
      tar.x({
        file: params.archivePath,
        cwd: params.destDir,
        strip,
        gzip: params.tarGzip,
        preservePaths: false,
        strict: true,
        onReadEntry(entry) {
          const archiveEntryPath =
            typeof entry === "object" && entry !== null && "path" in entry
              ? String((entry as { path: unknown }).path)
              : "";
          const archiveEntryType =
            typeof entry === "object" && entry !== null && "type" in entry
              ? String((entry as { type: unknown }).type)
              : "";
          const archiveEntrySize =
            typeof entry === "object" &&
            entry !== null &&
            "size" in entry &&
            typeof (entry as { size?: unknown }).size === "number" &&
            Number.isFinite((entry as { size: number }).size)
              ? Math.max(0, Math.floor((entry as { size: number }).size))
              : 0;

          try {
            validateArchiveEntryPath(archiveEntryPath);

            const relPath = stripArchivePath(archiveEntryPath, strip);
            if (!relPath) {
              return;
            }
            validateArchiveEntryPath(relPath);
            resolveCheckedOutPath(params.destDir, relPath, archiveEntryPath);

            if (
              archiveEntryType === "SymbolicLink" ||
              archiveEntryType === "Link" ||
              archiveEntryType === "BlockDevice" ||
              archiveEntryType === "CharacterDevice" ||
              archiveEntryType === "FIFO" ||
              archiveEntryType === "Socket"
            ) {
              throw new Error(`tar entry is a link: ${archiveEntryPath}`);
            }

            entryCount += 1;
            if (entryCount > limits.maxEntries) {
              throw new Error("archive entry count exceeds limit");
            }

            if (archiveEntrySize > limits.maxEntryBytes) {
              throw new Error("archive entry extracted size exceeds limit");
            }
            extractedBytes += archiveEntrySize;
            if (extractedBytes > limits.maxExtractedBytes) {
              throw new Error("archive extracted size exceeds limit");
            }
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
