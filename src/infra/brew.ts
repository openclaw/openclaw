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

type BrewResolutionOptions = {
  homeDir?: string;
  /**
   * @deprecated No-op compatibility field for plugin SDK callers. Homebrew
   * env vars are ignored for resolution because workspace env can be untrusted.
   */
  env?: NodeJS.ProcessEnv;
};

export function resolveBrewPathDirs(opts?: BrewResolutionOptions): string[] {
  const homeDir = opts?.homeDir ?? os.homedir();

  const dirs: string[] = [];

  // Linuxbrew defaults.
  dirs.push(path.join(homeDir, ".linuxbrew", "bin"));
  dirs.push(path.join(homeDir, ".linuxbrew", "sbin"));
  dirs.push("/home/linuxbrew/.linuxbrew/bin", "/home/linuxbrew/.linuxbrew/sbin");

  // macOS defaults (also used by some Linux setups).
  dirs.push("/opt/homebrew/bin", "/usr/local/bin");

  return dirs;
}

export function resolveBrewExecutable(opts?: BrewResolutionOptions): string | undefined {
  const homeDir = opts?.homeDir ?? os.homedir();

  const candidates: string[] = [];

  // Linuxbrew defaults.
  candidates.push(path.join(homeDir, ".linuxbrew", "bin", "brew"));
  candidates.push("/home/linuxbrew/.linuxbrew/bin/brew");

  // macOS defaults.
  candidates.push("/opt/homebrew/bin/brew", "/usr/local/bin/brew");

  for (const candidate of candidates) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
