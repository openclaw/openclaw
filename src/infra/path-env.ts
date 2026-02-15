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

function isExecutable(filePath: string): boolean {
  try {
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

function mergePath(params: { existing: string; prepend?: string[]; append?: string[] }): string {
  const partsExisting = params.existing
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
  const partsPrepend = (params.prepend ?? []).map((part) => part.trim()).filter(Boolean);
  const partsAppend = (params.append ?? []).map((part) => part.trim()).filter(Boolean);

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const part of [...partsPrepend, ...partsExisting, ...partsAppend]) {
    if (!seen.has(part)) {
      seen.add(part);
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

  const prepend: string[] = [];
  const append: string[] = [];

  // Bundled macOS app: `openclaw` lives next to the executable (process.execPath).
  try {
    const execDir = path.dirname(execPath);
    const siblingCli = path.join(execDir, "openclaw");
    if (isExecutable(siblingCli)) {
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
    if (isExecutable(path.join(localBinDir, "openclaw"))) {
      append.push(localBinDir);
    }
  }

  const miseDataDir = process.env.MISE_DATA_DIR ?? path.join(homeDir, ".local", "share", "mise");
  const miseShims = path.join(miseDataDir, "shims");
  if (isDirectory(miseShims)) {
    prepend.push(miseShims);
  }

  prepend.push(...resolveBrewPathDirs({ homeDir }));

  // Common global install locations (macOS first).
  if (platform === "darwin") {
    prepend.push(path.join(homeDir, "Library", "pnpm"));
  }
  if (process.env.XDG_BIN_HOME) {
    prepend.push(process.env.XDG_BIN_HOME);
  }
  prepend.push(path.join(homeDir, ".local", "bin"));
  prepend.push(path.join(homeDir, ".local", "share", "pnpm"));
  prepend.push(path.join(homeDir, ".bun", "bin"));
  prepend.push(path.join(homeDir, ".yarn", "bin"));
  prepend.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin");

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

  const merged = mergePath({ existing, prepend, append });
  if (merged) {
    process.env.PATH = merged;
  }
}
