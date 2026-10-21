import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeStringEntries,
  normalizeUniqueStringEntries,
} from "@openclaw/normalization-core/string-normalization";
import { resolveBrewPathDirs } from "./brew.js";
import { isTruthyEnvValue } from "./env.js";
import { canAccessSync } from "./path-existence.js";
import { isPathInside, safeStatSync } from "./path-guards.js";
import { tryProcessCwd } from "./safe-cwd.js";

function isKnownPathDir(existingPathParts: ReadonlySet<string>, dirPath: string): boolean {
  return existingPathParts.has(dirPath) || safeStatSync(dirPath)?.isDirectory() === true;
}

function realpathExistingPath(candidate: string): string | undefined {
  const suffix: string[] = [];
  let current = candidate;
  while (true) {
    try {
      return path.resolve(fs.realpathSync.native(current), ...suffix.toReversed());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function isFilesystemRoot(dirPath: string): boolean {
  return path.dirname(dirPath) === dirPath;
}

function normalizeTrustedPackageManagerRoot(params: {
  value: string | undefined;
  cwd: string | undefined;
  homeDir: string;
}): string | undefined {
  const trimmed = params.value?.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    return undefined;
  }
  const normalized = path.normalize(trimmed);
  if (normalized === "/proc" || normalized.startsWith(`/proc${path.sep}`)) {
    return undefined;
  }
  if (!params.cwd) {
    return normalized;
  }

  const cwd = path.resolve(params.cwd);
  const homeDir = path.resolve(params.homeDir);
  if (cwd === homeDir || isFilesystemRoot(cwd)) {
    return normalized;
  }
  if (isPathInside(cwd, normalized)) {
    return undefined;
  }

  const realCandidate = realpathExistingPath(normalized);
  const realCwd = realpathExistingPath(cwd);
  const realHome = realpathExistingPath(homeDir);
  if (
    realCwd &&
    realCwd !== realHome &&
    !isFilesystemRoot(realCwd) &&
    realCandidate &&
    isPathInside(realCwd, realCandidate)
  ) {
    return undefined;
  }
  return normalized;
}

function resolveMiseDataDir(params: { homeDir: string; platform: NodeJS.Platform }): string {
  const miseDataDir = process.env.MISE_DATA_DIR;
  if (miseDataDir !== undefined) {
    return miseDataDir;
  }

  // Match mise's override/XDG/platform order; candidate validation and PATH
  // placement remain owned by the existing bootstrap policy below.
  const xdgDataHome = process.env.XDG_DATA_HOME;
  if (xdgDataHome !== undefined) {
    return path.join(xdgDataHome, "mise");
  }
  if (params.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(params.homeDir, "AppData", "Local");
    return path.join(localAppData, "mise");
  }
  return path.join(params.homeDir, ".local", "share", "mise");
}

function candidateBinDirs(existingPathParts: ReadonlySet<string>): {
  prepend: string[];
  append: string[];
} {
  const execPath = process.execPath;
  const cwd = tryProcessCwd();
  const homeDir = os.homedir();
  const platform = process.platform;

  const prepend: string[] = [];
  const append: string[] = [];

  // Keep the active runtime directory ahead of PATH hardening so shebang-based
  // subprocesses keep using the same Node/Bun the current OpenClaw process is on.
  const execDir = path.dirname(execPath);
  if (canAccessSync(execPath, fs.constants.X_OK)) {
    prepend.push(execDir);
  }

  // Bundled macOS app: `openclaw` lives next to the executable (process.execPath).
  if (canAccessSync(path.join(execDir, "openclaw"), fs.constants.X_OK)) {
    prepend.push(execDir);
  }

  // Project-local installs are a common repo-based attack vector (bin hijacking). Keep this
  // disabled by default; if an operator explicitly enables it, only append (never prepend).
  if (isTruthyEnvValue(process.env.OPENCLAW_ALLOW_PROJECT_LOCAL_BIN) && cwd) {
    const localBinDir = path.join(cwd, "node_modules", ".bin");
    if (canAccessSync(path.join(localBinDir, "openclaw"), fs.constants.X_OK)) {
      append.push(localBinDir);
    }
  }

  // Only immutable OS directories go in prepend so they take priority over
  // user-writable locations, preventing PATH hijack of system binaries.
  prepend.push("/usr/bin", "/bin");

  // User-writable / package-manager directories are appended so they never
  // shadow trusted OS binaries.
  // This includes Brew/Homebrew dirs, which are useful for finding `openclaw`
  // in launchd/minimal environments but must not be treated as trusted.
  append.push(
    ...resolveBrewPathDirs({ homeDir }).filter(
      (candidate) =>
        platform !== "darwin" ||
        !candidate.split(path.sep).includes(".linuxbrew") ||
        existingPathParts.has(candidate),
    ),
  );
  const pnpmHome = normalizeTrustedPackageManagerRoot({
    value: process.env.PNPM_HOME,
    cwd,
    homeDir,
  });
  if (pnpmHome) {
    append.push(pnpmHome, path.join(pnpmHome, "bin"));
  }
  const npmPrefix = normalizeTrustedPackageManagerRoot({
    value: process.env.NPM_CONFIG_PREFIX,
    cwd,
    homeDir,
  });
  if (npmPrefix) {
    append.push(path.join(npmPrefix, "bin"));
  }
  const miseDataDir = resolveMiseDataDir({ homeDir, platform });
  const miseShims = path.join(miseDataDir, "shims");
  if (isKnownPathDir(existingPathParts, miseShims)) {
    append.push(miseShims);
  }
  if (platform === "darwin") {
    append.push(
      path.join(homeDir, "Library", "pnpm", "bin"),
      path.join(homeDir, "Library", "pnpm"),
    );
  }
  if (process.env.XDG_BIN_HOME) {
    append.push(process.env.XDG_BIN_HOME);
  }
  append.push(path.join(homeDir, ".local", "bin"));
  append.push(path.join(homeDir, ".npm-global", "bin"));
  append.push(path.join(homeDir, ".local", "share", "pnpm", "bin"));
  append.push(path.join(homeDir, ".local", "share", "pnpm"));
  append.push(path.join(homeDir, ".bun", "bin"));
  append.push(path.join(homeDir, ".yarn", "bin"));

  return {
    prepend: prepend.filter((candidate) => isKnownPathDir(existingPathParts, candidate)),
    append: append.filter((candidate) => isKnownPathDir(existingPathParts, candidate)),
  };
}

/**
 * Best-effort PATH bootstrap so skills that require the `openclaw` CLI can run
 * under launchd/minimal environments (and inside the macOS app bundle).
 */
export function ensureOpenClawCliOnPath() {
  if (isTruthyEnvValue(process.env.OPENCLAW_PATH_BOOTSTRAPPED)) {
    return;
  }
  // Mark before filesystem probing so repeated calls from nested bootstraps do
  // not keep reshuffling PATH.
  process.env.OPENCLAW_PATH_BOOTSTRAPPED = "1";

  const existing = process.env.PATH ?? "";
  const existingPathParts = new Set(normalizeStringEntries(existing.split(path.delimiter)));
  const { prepend, append } = candidateBinDirs(existingPathParts);
  if (prepend.length === 0 && append.length === 0) {
    return;
  }

  const merged = normalizeUniqueStringEntries([
    ...prepend,
    ...existing.split(path.delimiter),
    ...append,
  ]).join(path.delimiter);
  if (merged) {
    process.env.PATH = merged;
  }
}
