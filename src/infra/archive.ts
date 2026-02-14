import JSZip from "jszip";
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";

export type ArchiveKind = "tar" | "zip";

export type ArchiveLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
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
  const normalized = path.posix.normalize(normalizeArchivePath(entryPath));
  if (!normalized || normalized === "." || normalized === "./") {
    return null;
  }

  // Keep the validation separate so callers can reject traversal in the original
  // path even if stripping could make it "look" safe.
  const parts = normalized.split("/").filter((part) => part.length > 0 && part !== ".");
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

async function extractZip(params: {
  archivePath: string;
  destDir: string;
  stripComponents?: number;
}): Promise<void> {
  const buffer = await fs.readFile(params.archivePath);
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files);
  const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));

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
    const data = await entry.async("nodebuffer");
    await fs.writeFile(outPath, data);

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
  logger?: ArchiveLogger;
}): Promise<void> {
  const kind = params.kind ?? resolveArchiveKind(params.archivePath);
  if (!kind) {
    throw new Error(`unsupported archive: ${params.archivePath}`);
  }

  const label = kind === "zip" ? "extract zip" : "extract tar";
  if (kind === "tar") {
    const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));
    let firstError: Error | undefined;
    await withTimeout(
      tar.x({
        file: params.archivePath,
        cwd: params.destDir,
        strip,
        gzip: params.tarGzip,
        preservePaths: false,
        strict: true,
        filter: (entryPath, entry) => {
          try {
            validateArchiveEntryPath(entryPath);
            // `tar`'s filter callback can pass either a ReadEntry or a Stats-ish object;
            // fail closed for any link-like entries.
            const entryType =
              typeof entry === "object" &&
              entry !== null &&
              "type" in entry &&
              typeof (entry as { type?: unknown }).type === "string"
                ? (entry as { type: string }).type
                : undefined;
            const isSymlink =
              typeof entry === "object" &&
              entry !== null &&
              "isSymbolicLink" in entry &&
              typeof (entry as { isSymbolicLink?: unknown }).isSymbolicLink === "function" &&
              Boolean((entry as { isSymbolicLink: () => boolean }).isSymbolicLink());
            if (entryType === "SymbolicLink" || entryType === "Link" || isSymlink) {
              throw new Error(`tar entry is a link: ${entryPath}`);
            }
            const relPath = stripArchivePath(entryPath, strip);
            if (!relPath) {
              return false;
            }
            validateArchiveEntryPath(relPath);
            resolveCheckedOutPath(params.destDir, relPath, entryPath);
            return true;
          } catch (err) {
            if (!firstError) {
              firstError = err instanceof Error ? err : new Error(String(err));
            }
            return false;
          }
        },
      }),
      params.timeoutMs,
      label,
    );
    if (firstError) {
      throw firstError;
    }
    return;
  }

  await withTimeout(
    extractZip({
      archivePath: params.archivePath,
      destDir: params.destDir,
      stripComponents: params.stripComponents,
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
