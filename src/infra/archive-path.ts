import path from "node:path";
import { resolveSafeBaseDir } from "./path-safety.js";

export function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

export function normalizeArchiveEntryPath(raw: string): string {
  return raw.replaceAll("\\", "/");
}

export function validateArchiveEntryPath(
  entryPath: string,
  params?: { escapeLabel?: string },
): void {
  if (!entryPath || entryPath === "." || entryPath === "./") {
    return;
  }
  if (isWindowsDrivePath(entryPath)) {
    throw new Error(`archive entry uses a drive path: ${entryPath}`);
  }
  const normalized = path.posix.normalize(normalizeArchiveEntryPath(entryPath));
  const escapeLabel = params?.escapeLabel ?? "destination";
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`archive entry escapes ${escapeLabel}: ${entryPath}`);
  }
  if (path.posix.isAbsolute(normalized) || normalized.startsWith("//")) {
    throw new Error(`archive entry is absolute: ${entryPath}`);
  }
}

export function stripArchivePath(entryPath: string, stripComponents: number): string | null {
  const raw = normalizeArchiveEntryPath(entryPath);
  if (!raw || raw === "." || raw === "./") {
    return null;
  }

  // Mimic tar --strip-components semantics (raw segments before normalization)
  // so strip-induced escapes like "a/../b" are visible to validators.
  const parts = raw.split("/").filter((part) => part.length > 0 && part !== ".");
  const strip = Math.max(0, Math.floor(stripComponents));
  const stripped = strip === 0 ? parts.join("/") : parts.slice(strip).join("/");
  const result = path.posix.normalize(stripped);
  if (!result || result === "." || result === "./") {
    return null;
  }
  return result;
}

export function resolveArchiveOutputPath(params: {
  rootDir: string;
  relPath: string;
  originalPath: string;
  escapeLabel?: string;
}): string {
  const safeBase = resolveSafeBaseDir(params.rootDir);
  const outPath = path.resolve(params.rootDir, params.relPath);
  const escapeLabel = params.escapeLabel ?? "destination";
  if (!outPath.startsWith(safeBase)) {
    throw new Error(`archive entry escapes ${escapeLabel}: ${params.originalPath}`);
  }
  return outPath;
}
