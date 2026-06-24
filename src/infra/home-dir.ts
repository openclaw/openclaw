// Resolves OpenClaw home and platform-specific config directories.
import os from "node:os";
import path from "node:path";
import { tryProcessCwd } from "./safe-cwd.js";

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") {
    return undefined;
  }
  return trimmed;
}

function normalizeSafe(homedir: () => string): string | undefined {
  try {
    return normalize(homedir());
  } catch {
    return undefined;
  }
}

function resolveTermuxHome(env: NodeJS.ProcessEnv): string | undefined {
  const prefix = normalize(env.PREFIX);
  if (!prefix || !normalize(env.ANDROID_DATA)) {
    return undefined;
  }
  // Termux exposes PREFIX under the app sandbox; other Android/chroot prefixes
  // should not be treated as user-home evidence.
  if (!/(?:^|\/)com\.termux\/files\/usr\/?$/u.test(prefix.replace(/\\/gu, "/"))) {
    return undefined;
  }
  return path.resolve(prefix, "..", "home");
}

function resolveRawOsHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string | undefined {
  return (
    normalize(env.HOME) ??
    normalize(env.USERPROFILE) ??
    resolveTermuxHome(env) ??
    normalizeSafe(homedir)
  );
}

function resolveRawHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string | undefined {
  const explicitHome = normalize(env.OPENCLAW_HOME);
  if (!explicitHome) {
    return resolveRawOsHomeDir(env, homedir);
  }
  if (explicitHome === "~" || explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
    const fallbackHome = resolveRawOsHomeDir(env, homedir);
    return fallbackHome ? explicitHome.replace(/^~(?=$|[\\/])/, fallbackHome) : undefined;
  }
  return explicitHome;
}

/** Resolves OpenClaw's effective home, honoring OPENCLAW_HOME before OS homes. */
export function resolveEffectiveHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  const raw = resolveRawHomeDir(env, homedir);
  return raw ? path.resolve(raw) : undefined;
}

/** Resolves the underlying OS user home, ignoring OPENCLAW_HOME overrides. */
export function resolveOsHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  const raw = resolveRawOsHomeDir(env, homedir);
  return raw ? path.resolve(raw) : undefined;
}

/**
 * Resolves the effective home, or falls back to cwd when no home source exists.
 *
 * Home sources are tried first (OPENCLAW_HOME, HOME, USERPROFILE, Termux,
 * os.homedir()). When none resolve, the launch cwd is used if it still exists.
 *
 * If the cwd has also been deleted, this throws a clear actionable error rather
 * than silently writing state under the runtime install directory:
 * resolveStateDir() derives mutable state/config/auth-adjacent paths from this
 * value, so the Node/Bun binary dir is an unsafe state root (and a read-only
 * install would fail on the next state write anyway). The no-home + deleted-cwd
 * combination is unrecoverable, so it is surfaced explicitly instead of masked
 * with a guessed directory. See issue #73676.
 */
export function resolveRequiredHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const home = resolveEffectiveHomeDir(env, homedir);
  if (home) {
    return home;
  }
  const cwd = tryProcessCwd();
  if (cwd) {
    return path.resolve(cwd);
  }
  throw new Error(
    "OpenClaw could not determine a home directory for state storage: no OPENCLAW_HOME, HOME, or USERPROFILE is set, os.homedir() is unavailable, and the current working directory has been deleted. Set OPENCLAW_HOME (or HOME/USERPROFILE) to an existing directory, or run OpenClaw from a directory that still exists.",
  );
}

/**
 * Resolves the OS home, or falls back to cwd when no OS home source exists.
 *
 * Like resolveRequiredHomeDir but ignores OPENCLAW_HOME. Throws a clear
 * actionable error when no OS home source resolves and the cwd is deleted,
 * for the same state-root safety reason as resolveRequiredHomeDir.
 */
export function resolveRequiredOsHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const home = resolveOsHomeDir(env, homedir);
  if (home) {
    return home;
  }
  const cwd = tryProcessCwd();
  if (cwd) {
    return path.resolve(cwd);
  }
  throw new Error(
    "OpenClaw could not determine an OS home directory for state storage: no HOME or USERPROFILE is set, os.homedir() is unavailable, and the current working directory has been deleted. Set HOME (or USERPROFILE) to an existing directory, or run OpenClaw from a directory that still exists.",
  );
}

/** Expands leading `~`, `~/`, or `~\` with the effective home when one is known. */
export function expandHomePrefix(
  input: string,
  opts?: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  if (!input.startsWith("~")) {
    return input;
  }
  const home =
    normalize(opts?.home) ??
    resolveEffectiveHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir);
  if (!home) {
    return input;
  }
  return input.replace(/^~(?=$|[\\/])/, home);
}

/** Resolves a user-supplied path after trimming and expanding against the effective home. */
export function resolveHomeRelativePath(
  input: string,
  opts?: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const expanded = expandHomePrefix(trimmed, {
      home: resolveRequiredHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir),
      env: opts?.env,
      homedir: opts?.homedir,
    });
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}

/**
 * Backward-compatible alias for resolving user paths against the effective home.
 *
 * @deprecated Use resolveHomeRelativePath.
 */
export function resolveUserPath(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return resolveHomeRelativePath(input, { env, homedir });
}

/** Resolves a user-supplied path against the OS home, ignoring OPENCLAW_HOME. */
export function resolveOsHomeRelativePath(
  input: string,
  opts?: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const expanded = expandHomePrefix(trimmed, {
      home: resolveRequiredOsHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir),
      env: opts?.env,
      homedir: opts?.homedir,
    });
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}
