import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canAccessSync } from "./path-existence.js";

type BrewResolutionOptions = {
  homeDir?: string;
  /**
   * @deprecated No-op compatibility field for plugin SDK callers. Homebrew
   * env vars are ignored for resolution because workspace env can be untrusted.
   */
  env?: NodeJS.ProcessEnv;
};

/** Returns standard Homebrew bin directories suitable for PATH augmentation. */
export function resolveBrewPathDirs(opts?: BrewResolutionOptions): string[] {
  const homeDir = opts?.homeDir ?? os.homedir();

  return [
    path.join(homeDir, ".linuxbrew", "bin"),
    path.join(homeDir, ".linuxbrew", "sbin"),
    "/home/linuxbrew/.linuxbrew/bin",
    "/home/linuxbrew/.linuxbrew/sbin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

/** Resolves an executable `brew` path from trusted PATH entries or standard install roots. */
export function resolveBrewExecutable(opts?: BrewResolutionOptions): string | undefined {
  const homeDir = opts?.homeDir ?? os.homedir();

  // Use the real process PATH, not opts.env, because callers may pass workspace
  // env loaded from untrusted project state.
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) {
      continue;
    }
    const candidate = path.join(trimmed, "brew");
    if (canAccessSync(candidate, fs.constants.X_OK)) {
      return candidate;
    }
  }

  return [
    path.join(homeDir, ".linuxbrew", "bin", "brew"),
    "/home/linuxbrew/.linuxbrew/bin/brew",
    "/opt/homebrew/bin/brew",
    "/usr/local/bin/brew",
  ].find((candidate) => canAccessSync(candidate, fs.constants.X_OK));
}

/** Recognize formula-owned OpenClaw files and keep service paths independent of the keg version. */
export async function resolveBrewOpenClawPath(inputPath: string): Promise<string | null> {
  const match =
    /^(.*)\/(?:Cellar\/openclaw-cli\/[^/]+|opt\/openclaw-cli)(\/libexec(?:\/.*)?)$/u.exec(
      inputPath,
    );
  if (!match || process.platform === "win32") {
    return null;
  }
  const [, prefix, suffix] = match;
  const prefixes = [
    process.env.HOMEBREW_PREFIX,
    ...resolveBrewPathDirs().map((dir) => path.dirname(dir)),
  ];
  if (
    !prefixes.some((value) => value && path.isAbsolute(value) && path.resolve(value) === prefix)
  ) {
    const brew = resolveBrewExecutable();
    if (!brew) {
      return null;
    }
    const { runCommandWithTimeout } = await import("../process/exec.js");
    const result = await runCommandWithTimeout([brew, "--prefix"], { timeoutMs: 5_000 }).catch(
      () => null,
    );
    if (result?.code !== 0 || result.stdout.trim() !== prefix) {
      return null;
    }
  }
  return path.join(prefix!, "opt", "openclaw-cli", suffix!);
}
