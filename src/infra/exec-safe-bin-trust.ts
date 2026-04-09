import fs from "node:fs";
import path from "node:path";

// Keep defaults to OS-managed immutable bins only.
// Mutable locations (package-manager bins, home-scoped bins, relative/workspace dirs)
// must use explicit path-based approvals instead of the safe-bin fast path.
const DEFAULT_SAFE_BIN_TRUSTED_DIRS = ["/bin", "/usr/bin"];

type TrustedSafeBinDirsParams = {
  baseDirs?: readonly string[];
  extraDirs?: readonly string[];
};

type TrustedSafeBinPathParams = {
  resolvedPath: string;
  trustedDirs?: ReadonlySet<string>;
};

type TrustedSafeBinCache = {
  key: string;
  dirs: Set<string>;
};

export type WritableTrustedSafeBinDir = {
  dir: string;
  groupWritable: boolean;
  worldWritable: boolean;
};

export function classifyRiskyExplicitSafeBinTrustedDir(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (!path.isAbsolute(trimmed)) {
    return "relative/workspace-scoped directory is mutable and depends on process cwd";
  }
  const normalized = path.resolve(trimmed).replace(/\\/g, "/").toLowerCase();
  const normalizedCwd = path.resolve(process.cwd()).replace(/\\/g, "/").toLowerCase();
  if (normalized === normalizedCwd || normalized.startsWith(`${normalizedCwd}/`)) {
    return "workspace-scoped directory is mutable and depends on project contents";
  }
  if (normalized === "/usr/local/bin") {
    return "package-manager bin directory is mutable and not an immutable safe-bin root";
  }
  if (normalized === "/snap/bin") {
    return "snap shim directory is mutable and not an immutable safe-bin root";
  }
  if (
    normalized.startsWith("/home/") ||
    normalized.startsWith("/users/") ||
    normalized.includes("/.nvm/") ||
    normalized.endsWith("/.nvm") ||
    normalized.includes("/.local/bin")
  ) {
    return "home-scoped bin directory is mutable and not an immutable safe-bin root";
  }
  return null;
}

let trustedSafeBinCache: TrustedSafeBinCache | null = null;

function normalizeTrustedDir(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return path.resolve(trimmed);
}

export function normalizeTrustedSafeBinDirs(entries?: readonly string[] | null): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  const normalized = entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return Array.from(new Set(normalized));
}

function resolveTrustedSafeBinDirs(entries: readonly string[]): string[] {
  const resolved = entries
    .filter((entry) => !classifyRiskyExplicitSafeBinTrustedDir(entry))
    .map((entry) => normalizeTrustedDir(entry))
    .filter((entry): entry is string => Boolean(entry));
  return Array.from(new Set(resolved)).toSorted();
}

function buildTrustedSafeBinCacheKey(entries: readonly string[]): string {
  return resolveTrustedSafeBinDirs(normalizeTrustedSafeBinDirs(entries)).join("\u0001");
}

export function buildTrustedSafeBinDirs(params: TrustedSafeBinDirsParams = {}): Set<string> {
  const baseDirs = params.baseDirs ?? DEFAULT_SAFE_BIN_TRUSTED_DIRS;
  const extraDirs = params.extraDirs ?? [];
  // Trust is explicit only. Do not derive from PATH, which is user/environment controlled.
  return new Set(
    resolveTrustedSafeBinDirs([
      ...normalizeTrustedSafeBinDirs(baseDirs),
      ...normalizeTrustedSafeBinDirs(extraDirs),
    ]),
  );
}

export function getTrustedSafeBinDirs(
  params: {
    baseDirs?: readonly string[];
    extraDirs?: readonly string[];
    refresh?: boolean;
  } = {},
): Set<string> {
  const baseDirs = params.baseDirs ?? DEFAULT_SAFE_BIN_TRUSTED_DIRS;
  const extraDirs = params.extraDirs ?? [];
  const key = buildTrustedSafeBinCacheKey([...baseDirs, ...extraDirs]);

  if (!params.refresh && trustedSafeBinCache?.key === key) {
    return trustedSafeBinCache.dirs;
  }

  const dirs = buildTrustedSafeBinDirs({
    baseDirs,
    extraDirs,
  });
  trustedSafeBinCache = { key, dirs };
  return dirs;
}

export function isTrustedSafeBinPath(params: TrustedSafeBinPathParams): boolean {
  const trustedDirs = params.trustedDirs ?? getTrustedSafeBinDirs();
  const resolvedDir = path.dirname(path.resolve(params.resolvedPath));
  return trustedDirs.has(resolvedDir);
}

export function listWritableExplicitTrustedSafeBinDirs(
  entries?: readonly string[] | null,
): WritableTrustedSafeBinDir[] {
  if (process.platform === "win32") {
    return [];
  }
  const resolved = resolveTrustedSafeBinDirs(normalizeTrustedSafeBinDirs(entries));
  const hits: WritableTrustedSafeBinDir[] = [];
  for (const dir of resolved) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }
    const mode = stat.mode & 0o777;
    const groupWritable = (mode & 0o020) !== 0;
    const worldWritable = (mode & 0o002) !== 0;
    if (!groupWritable && !worldWritable) {
      continue;
    }
    hits.push({ dir, groupWritable, worldWritable });
  }
  return hits;
}
