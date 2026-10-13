import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { resolveEnvironmentValue } from "../infra/process-env.js";
import { matchesVersionManagerPath } from "../shared/version-manager-path.js";

function isSameWindowsDirectory(
  previous: string | undefined,
  proposed: string | undefined,
): boolean {
  if (
    !previous?.trim() ||
    !proposed?.trim() ||
    ![previous, proposed].every(
      (value) => path.win32.isAbsolute(value) && path.win32.parse(value).root.length > 1,
    )
  ) {
    return false;
  }
  try {
    const previousStat = fs.statSync(previous, { bigint: true });
    const proposedStat = fs.statSync(proposed, { bigint: true });
    return (
      previousStat.isDirectory() &&
      proposedStat.isDirectory() &&
      previousStat.ino !== 0n &&
      previousStat.dev === proposedStat.dev &&
      previousStat.ino === proposedStat.ino
    );
  } catch {
    // Uninspectable paths remain subject to the strict preservation audit.
    return false;
  }
}

/** Shell and desktop TEMP can name the same Windows directory through different 8.3 aliases. */
export function preserveServiceTmpDir(
  environment: Record<string, string | undefined>,
  existing: Record<string, string | undefined> | undefined,
  platform: NodeJS.Platform,
): void {
  if (platform !== "win32") {
    return;
  }
  const previous = resolveEnvironmentValue(existing, "TMPDIR", platform);
  if (isSameWindowsDirectory(previous, resolveEnvironmentValue(environment, "TMPDIR", platform))) {
    environment.TMPDIR = previous;
  }
}

/** Same-account elevation can omit the HOME that a shell install recorded. */
export function preserveServiceAccountHome(
  environment: Record<string, string | undefined>,
  existing: Record<string, string | undefined> | undefined,
  platform: NodeJS.Platform,
): void {
  if (
    platform !== "win32" ||
    resolveEnvironmentValue(environment, "HOME", platform) !== undefined
  ) {
    return;
  }
  const previous = resolveEnvironmentValue(existing, "HOME", platform);
  if (!previous?.trim()) {
    return;
  }
  try {
    // The OS account profile, unlike HOME/USERPROFILE, is not an invocation override.
    if (isSameWindowsDirectory(previous, os.userInfo().homedir)) {
      environment.HOME = previous;
    }
  } catch {
    // An unavailable account identity cannot authorize preserving its HOME.
  }
}

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
    const realSegment = resolveIdentityPathViaExistingAncestorSync(normalized);
    try {
      const realCwd = path.normalize(fs.realpathSync.native(cwd));
      if (isSameOrChildPath(realSegment, realCwd)) {
        return undefined;
      }
    } catch {
      // Unavailable cwd identity leaves the lexical check in force.
    }
    if (isNonMinimalServicePathEntry(normalized, platform)) {
      return undefined;
    }
    return [...normalizedTmpDirs, ...realTmpDirs].some(
      (tmpRoot) =>
        isSameOrChildPath(normalized, tmpRoot) || isSameOrChildPath(realSegment, tmpRoot),
    )
      ? undefined
      : normalized;
  };
  const addPath = (value: string | undefined, options?: { preserve?: boolean }) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      return;
    }
    for (const segment of value.split(path.delimiter)) {
      const trimmed = segment.trim();
      const candidate = options?.preserve ? normalizePreservedPathSegment(trimmed) : trimmed;
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
