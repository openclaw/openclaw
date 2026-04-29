import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBrewPathDirs } from "./brew.js";
import { isTruthyEnvValue } from "./env.js";

type EnsureOpenClawPathOpts = {
  execPath?: string;
  cwd?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  pathEnv?: string;
  allowProjectLocalBin?: boolean;
};

const WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat", ".com"];

function isExecutable(filePath: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (platform === "win32") {
      const ext = path.extname(filePath).toLowerCase();
      if (ext && WINDOWS_EXECUTABLE_EXTENSIONS.includes(ext)) {
        return fs.existsSync(filePath);
      }
      // If no extension, try common ones
      for (const winExt of WINDOWS_EXECUTABLE_EXTENSIONS) {
        if (fs.existsSync(filePath + winExt)) {
          return true;
        }
      }
      return fs.existsSync(filePath);
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function mergePath(params: {
  existing: string;
  prepend?: string[];
  append?: string[];
  platform?: NodeJS.Platform;
}): string {
  const platform = params.platform ?? process.platform;
  const isWin = platform === "win32";

  const partsExisting = params.existing
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
  const partsPrepend = (params.prepend ?? []).map((part) => part.trim()).filter(Boolean);
  const partsAppend = (params.append ?? []).map((part) => part.trim()).filter(Boolean);

  const seen = new Set<string>();
  const merged: string[] = [];

  const normalize = (p: string) => (isWin ? path.resolve(p).toLowerCase() : p);

  for (const part of [...partsPrepend, ...partsExisting, ...partsAppend]) {
    const key = normalize(part);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(part);
    }
  }
  return merged.join(path.delimiter);
}

function candidateBinDirs(opts: EnsureOpenClawPathOpts): { prepend: string[]; append: string[] } {
  const execPath = opts.execPath ?? process.execPath;
  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.homeDir ?? os.homedir();
  const platform = opts.platform ?? process.platform;
  const isWin = platform === "win32";

  const prepend: string[] = [];
  const append: string[] = [];

  // Keep the active runtime directory ahead of PATH hardening so shebang-based
  // subprocesses keep using the same Node/Bun the current OpenClaw process is on.
  try {
    const execDir = path.dirname(execPath);
    if (isExecutable(execPath, platform)) {
      prepend.push(execDir);
    }
  } catch {
    // ignore
  }

  // Bundled macOS app: `openclaw` lives next to the executable (process.execPath).
  // On Windows, it might be openclaw.cmd or openclaw.exe.
  try {
    const execDir = path.dirname(execPath);
    const siblingCli = path.join(execDir, "openclaw");
    if (isExecutable(siblingCli, platform)) {
      prepend.push(execDir);
    }
  } catch {
    // ignore
  }

  // Project-local installs are a common repo-based attack vector (bin hijacking). Keep this
  // disabled by default; if an operator explicitly enables it, only append (never prepend).
  const allowProjectLocalBin =
    opts.allowProjectLocalBin === true ||
    isTruthyEnvValue(process.env.OPENCLAW_ALLOW_PROJECT_LOCAL_BIN);
  if (allowProjectLocalBin) {
    const localBinDir = path.join(cwd, "node_modules", ".bin");
    if (isExecutable(path.join(localBinDir, "openclaw"), platform)) {
      append.push(localBinDir);
    }
  }

  if (!isWin) {
    // Only immutable OS directories go in prepend so they take priority over
    // user-writable locations, preventing PATH hijack of system binaries.
    prepend.push("/usr/bin", "/bin");
  }

  // User-writable / package-manager directories are appended so they never
  // shadow trusted OS binaries.
  if (!isWin) {
    append.push(...resolveBrewPathDirs({ homeDir }));
    const miseDataDir = process.env.MISE_DATA_DIR ?? path.join(homeDir, ".local", "share", "mise");
    const miseShims = path.join(miseDataDir, "shims");
    if (isDirectory(miseShims)) {
      append.push(miseShims);
    }
  }

  if (platform === "darwin") {
    append.push(path.join(homeDir, "Library", "pnpm"));
  }

  if (isWin) {
    // Common Windows package manager paths
    const appData = process.env.APPDATA || path.join(homeDir, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
    append.push(path.join(appData, "pnpm"));
    append.push(path.join(localAppData, "pnpm"));
    append.push(path.join(homeDir, ".pnpm-bin")); // fallback
  }

  if (process.env.XDG_BIN_HOME) {
    append.push(process.env.XDG_BIN_HOME);
  }
  append.push(path.join(homeDir, ".local", "bin"));
  append.push(path.join(homeDir, ".local", "share", "pnpm"));
  append.push(path.join(homeDir, ".bun", "bin"));
  append.push(path.join(homeDir, ".yarn", "bin"));

  return { prepend: prepend.filter(isDirectory), append: append.filter(isDirectory) };
}

/**
 * Best-effort PATH bootstrap so skills that require the `openclaw` CLI can run
 * under launchd/minimal environments (and inside the macOS app bundle).
 */
export function ensureOpenClawCliOnPath(opts: EnsureOpenClawPathOpts = {}) {
  if (isTruthyEnvValue(process.env.OPENCLAW_PATH_BOOTSTRAPPED)) {
    return;
  }
  process.env.OPENCLAW_PATH_BOOTSTRAPPED = "1";

  const existing = opts.pathEnv ?? process.env.PATH ?? "";
  const { prepend, append } = candidateBinDirs(opts);
  if (prepend.length === 0 && append.length === 0) {
    return;
  }

  const merged = mergePath({
    existing,
    prepend,
    append,
    platform: opts.platform ?? process.platform,
  });
  if (merged) {
    process.env.PATH = merged;
  }
}
