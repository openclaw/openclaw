import fs from "node:fs/promises";
import path from "node:path";
import { resolveBrewExecutable } from "./brew.js";

/**
 * Detects whether an OpenClaw installation is managed by Homebrew.
 *
 * Homebrew-managed installations live under one of:
 *   - <HOMEBREW_PREFIX>/Cellar/openclaw/<version>/...        (versioned keg)
 *   - <HOMEBREW_PREFIX>/opt/openclaw/...                      (stable opt symlink)
 *
 * On macOS the default prefix is `/opt/homebrew` (Apple Silicon) or `/usr/local`
 * (Intel). On Linux it's `/home/linuxbrew/.linuxbrew` or `~/.linuxbrew`.
 *
 * Detection runs against the package root path itself and its realpath, so a
 * symlinked entrypoint (e.g. `/opt/homebrew/bin/openclaw`) still resolves to a
 * Homebrew install when followed back to a Cellar location.
 */

const CELLAR_OPENCLAW_RE = /[\\/]Cellar[\\/]openclaw[\\/]([^\\/]+)[\\/]/;
const OPT_OPENCLAW_RE = /[\\/]opt[\\/]openclaw[\\/]/;

export type HomebrewInstallInfo = {
  /** Cellar version segment (e.g. "2026.4.25") when matched via Cellar layout. */
  cellarVersion?: string;
  /** Realpath of the package root used for detection. */
  resolvedRoot: string;
  /** Brew executable path on PATH (best-effort, may be undefined). */
  brewPath?: string;
};

export function isHomebrewManagedRootPath(rootPath: string): boolean {
  if (!rootPath) {
    return false;
  }
  return CELLAR_OPENCLAW_RE.test(rootPath) || OPT_OPENCLAW_RE.test(rootPath);
}

export function extractHomebrewCellarVersion(rootPath: string): string | undefined {
  const match = rootPath.match(CELLAR_OPENCLAW_RE);
  return match?.[1] ?? undefined;
}

/**
 * Detects whether the resolved OpenClaw package root is a Homebrew-managed
 * install. Returns metadata when matched, otherwise null.
 *
 * Resolves the realpath of the supplied root before matching so symlinked
 * entrypoints (Homebrew/Linuxbrew opt symlinks) are recognized.
 */
export async function detectHomebrewInstall(opts: {
  packageRoot: string | null;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<HomebrewInstallInfo | null> {
  const root = opts.packageRoot?.trim();
  if (!root) {
    return null;
  }

  let resolved = root;
  try {
    resolved = await fs.realpath(root);
  } catch {
    // Keep the supplied path; some Homebrew layouts may not be readable here.
  }

  // Match against the realpath first (Cellar) and fall back to the original
  // input (opt symlink path that we deliberately did not resolve).
  const candidatePaths = [resolved, root].map((p) => path.resolve(p));

  let matched = false;
  let cellarVersion: string | undefined;
  for (const candidate of candidatePaths) {
    if (CELLAR_OPENCLAW_RE.test(candidate)) {
      matched = true;
      cellarVersion ??= extractHomebrewCellarVersion(candidate);
    } else if (OPT_OPENCLAW_RE.test(candidate)) {
      matched = true;
    }
  }

  if (!matched) {
    return null;
  }

  return {
    cellarVersion,
    resolvedRoot: resolved,
    brewPath: resolveBrewExecutable({
      homeDir: opts.homeDir,
      env: opts.env ?? process.env,
    }),
  };
}
