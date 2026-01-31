import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizePathValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveBrewPathDirs(opts?: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const homeDir = opts?.homeDir ?? os.homedir();
  const env = opts?.env ?? process.env;

  const dirs: string[] = [];
  const prefix = normalizePathValue(env.HOMEBREW_PREFIX);
  if (prefix) {
    dirs.push(path.join(prefix, "bin"), path.join(prefix, "sbin"));
  }

  // Linuxbrew defaults.
  dirs.push(path.join(homeDir, ".linuxbrew", "bin"));
  dirs.push(path.join(homeDir, ".linuxbrew", "sbin"));
  dirs.push("/home/linuxbrew/.linuxbrew/bin", "/home/linuxbrew/.linuxbrew/sbin");

  // macOS defaults (also used by some Linux setups).
  dirs.push("/opt/homebrew/bin", "/usr/local/bin");

  return dirs;
}

export function resolveBrewExecutable(opts?: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const homeDir = opts?.homeDir ?? os.homedir();
  const env = opts?.env ?? process.env;

  const candidates: string[] = [];

  const brewFile = normalizePathValue(env.HOMEBREW_BREW_FILE);
  if (brewFile) candidates.push(brewFile);

  const prefix = normalizePathValue(env.HOMEBREW_PREFIX);
  if (prefix) candidates.push(path.join(prefix, "bin", "brew"));

  // Linuxbrew defaults.
  candidates.push(path.join(homeDir, ".linuxbrew", "bin", "brew"));
  candidates.push("/home/linuxbrew/.linuxbrew/bin/brew");

  // macOS defaults.
  candidates.push("/opt/homebrew/bin/brew", "/usr/local/bin/brew");

  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  return undefined;
}
