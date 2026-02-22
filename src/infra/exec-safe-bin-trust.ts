import path from "node:path";

const DEFAULT_SAFE_BIN_TRUSTED_DIRS = [
  "/bin",
  "/usr/bin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/opt/local/bin",
  "/snap/bin",
  "/run/current-system/sw/bin",
];

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

let trustedSafeBinCache: TrustedSafeBinCache | null = null;

function normalizeTrustedDir(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return path.resolve(trimmed);
}

function buildTrustedSafeBinCacheKey(params: {
  baseDirs: readonly string[];
  extraDirs: readonly string[];
}): string {
  return `${params.baseDirs.join("\u0001")}\u0000${params.extraDirs.join("\u0001")}`;
}

export function buildTrustedSafeBinDirs(params: TrustedSafeBinDirsParams = {}): Set<string> {
  const baseDirs = params.baseDirs ?? DEFAULT_SAFE_BIN_TRUSTED_DIRS;
  const extraDirs = params.extraDirs ?? [];
  const trusted = new Set<string>();

  // Trust is explicit only. Do not derive from PATH, which is user/environment controlled.
  for (const entry of [...baseDirs, ...extraDirs]) {
    const normalized = normalizeTrustedDir(entry);
    if (normalized) {
      trusted.add(normalized);
    }
  }

  return trusted;
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
  const key = buildTrustedSafeBinCacheKey({ baseDirs, extraDirs });

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
