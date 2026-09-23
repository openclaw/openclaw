/** Classifies service PATH entries that should not be frozen into daemons. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { matchesVersionManagerPath } from "../shared/version-manager-path.js";

// Service PATH policy keeps managed services away from user shell package-manager paths.
export function normalizeServicePathEntry(entry: string, platform: NodeJS.Platform): string {
  const pathModule = platform === "win32" ? path.win32 : path.posix;
  const normalized = pathModule.normalize(entry).replaceAll("\\", "/");
  if (platform === "win32") {
    return normalizeLowercaseStringOrEmpty(normalized);
  }
  return normalized;
}

export function isNonMinimalServicePathEntry(entry: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    return false;
  }
  const normalized = normalizeServicePathEntry(entry, platform);
  // User shell package-manager paths are fragile in non-interactive services and
  // should be replaced by stable system/runtime paths.
  return (
    matchesVersionManagerPath(normalized, "service-path") ||
    normalized.includes("/.local/share/pnpm/") ||
    normalized.includes("/pnpm/") ||
    normalized.endsWith("/pnpm")
  );
}

export function mergeServicePath(
  nextPath: string | undefined,
  existingPath: string | undefined,
  tmpDir: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const segments: string[] = [];
  const seen = new Set<string>();
  const normalizedTmpDirs = [tmpDir, os.tmpdir()]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value));
  const realTmpDirs = normalizedTmpDirs.map((tmpRoot) => {
    try {
      return path.normalize(fs.realpathSync.native(tmpRoot));
    } catch {
      return tmpRoot;
    }
  });
  const isSameOrChildPath = (candidate: string, parent: string) =>
    candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
  const isUnsafeProcPath = (candidate: string) =>
    candidate === `${path.sep}proc` || candidate.startsWith(`${path.sep}proc${path.sep}`);
  const realpathExistingPath = (candidate: string): string | undefined => {
    const parts: string[] = [];
    let current = candidate;
    while (current && current !== path.dirname(current)) {
      try {
        const realCurrent = path.normalize(fs.realpathSync.native(current));
        return path.normalize(path.join(realCurrent, ...parts.toReversed()));
      } catch {
        parts.push(path.basename(current));
        current = path.dirname(current);
      }
    }
    try {
      return path.normalize(path.join(fs.realpathSync.native(current), ...parts.toReversed()));
    } catch {
      return undefined;
    }
  };
  const normalizePreservedPathSegment = (segment: string): string | undefined => {
    if (!path.isAbsolute(segment)) {
      return undefined;
    }
    const normalized = path.normalize(segment);
    if (isUnsafeProcPath(normalized)) {
      return undefined;
    }
    const cwd = path.resolve(process.cwd());
    if (isSameOrChildPath(normalized, cwd)) {
      return undefined;
    }
    try {
      const realSegment = realpathExistingPath(normalized);
      const realCwd = path.normalize(fs.realpathSync.native(cwd));
      if (realSegment && isSameOrChildPath(realSegment, realCwd)) {
        return undefined;
      }
    } catch {
      // Legacy PATH entries may no longer exist; keep filtering best-effort.
    }
    return normalized;
  };
  const shouldPreserveNormalizedPathSegment = (segment: string) => {
    if (isNonMinimalServicePathEntry(segment, platform)) {
      return false;
    }
    const resolved = path.resolve(segment);
    const realResolved = realpathExistingPath(resolved) ?? resolved;
    return ![...normalizedTmpDirs, ...realTmpDirs].some(
      (tmpRoot) => isSameOrChildPath(resolved, tmpRoot) || isSameOrChildPath(realResolved, tmpRoot),
    );
  };
  const addPath = (value: string | undefined, options?: { preserve?: boolean }) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      return;
    }
    for (const segment of value.split(path.delimiter)) {
      const trimmed = segment.trim();
      const candidate = options?.preserve ? normalizePreservedPathSegment(trimmed) : trimmed;
      if (options?.preserve && (!candidate || !shouldPreserveNormalizedPathSegment(candidate))) {
        continue;
      }
      if (!candidate || seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      segments.push(candidate);
    }
  };
  addPath(nextPath);
  if (platform !== "darwin") {
    addPath(existingPath, { preserve: true });
    // Regenerated entries are already admitted even when existing-only filters reject them.
    const platformPath = platform === "win32" ? path.win32 : path.posix;
    const normalizeOrderEntry = (entry: string) => {
      const normalized =
        platform === "win32"
          ? normalizeServicePathEntry(entry, platform)
          : platformPath.normalize(entry);
      return normalized.endsWith("/") && normalized !== platformPath.parse(normalized).root
        ? normalized.slice(0, -1)
        : normalized;
    };
    const admitted = new Map(segments.map((segment) => [normalizeOrderEntry(segment), segment]));
    const preserved = (existingPath?.split(path.delimiter) ?? []).flatMap((segment) => {
      const trimmed = segment.trim();
      const normalized = platformPath.normalize(trimmed);
      // Keep admitted spellings because the audit distinguishes trailing separators.
      const entry = seen.has(trimmed)
        ? trimmed
        : seen.has(normalized)
          ? normalized
          : admitted.get(normalizeOrderEntry(trimmed));
      return entry === undefined ? [] : [entry];
    });
    const existing = new Set(preserved.map(normalizeOrderEntry));
    const ordered = [
      ...segments.filter((segment) => !existing.has(normalizeOrderEntry(segment))),
      ...preserved,
    ];
    return ordered.length > 0 ? ordered.join(path.delimiter) : undefined;
  }
  return segments.length > 0 ? segments.join(path.delimiter) : undefined;
}
