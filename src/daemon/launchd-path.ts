import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveHomeDir } from "./paths.js";

type LaunchAgentPathEnv = Record<string, string | undefined>;

// `os.homedir()` reads the passwd entry via getpwuid_r, so it still returns
// a real /Users/<shortName> on macOS even when HOME/USERPROFILE have been
// stripped from the environment (e.g. by sanitizeHostExecEnv before a
// detached restart handoff). HEAD fell back to it inline at each restart
// caller; keep that behavior in one place so install/uninstall fail-fast
// semantics stay intact and detached restart/update paths stay alive.
function resolveHomeDirWithOsFallback(env: LaunchAgentPathEnv): string {
  try {
    return resolveHomeDir(env);
  } catch (err) {
    if (err instanceof Error && err.message === "Missing HOME") {
      return os.homedir();
    }
    throw err;
  }
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function trimTrailingSlashes(value: string): string {
  const trimmed = value.replace(/\/+$/g, "");
  return trimmed || "/";
}

function isBootVolumeUserHome(home: string): boolean {
  return /^\/Users\/[^/]+$/.test(home);
}

function normalizeUserName(value: string | undefined): string | null {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed || trimmed === "." || trimmed === ".." || /[/\\\s]/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function resolveShortUserName(env: LaunchAgentPathEnv): string | null {
  for (const value of [env.USER, env.LOGNAME, env.USERNAME]) {
    const normalized = normalizeUserName(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

// Parse `<prefix>/Users/<shortName>` out of an external macOS home path.
// Used as a fallback when USER/LOGNAME/USERNAME env are absent or unreliable
// (stripped env in detached restart handoffs, CI, sudo contexts): the
// filesystem path is harder to spoof than env vars, and the segment after
// the last `/Users/` is the same short name launchd needs on the boot volume.
// Linux /home/<name> does not match, and the only caller is macOS launchd
// plumbing, so this stays a macOS-shaped rule.
function extractUserNameFromHomePath(home: string): string | null {
  const match = /^\/.*\/Users\/([^/]+)$/.exec(home);
  if (!match) {
    return null;
  }
  return normalizeUserName(match[1]);
}

export function resolveLaunchAgentHomeDir(env: LaunchAgentPathEnv): string {
  const home = trimTrailingSlashes(toPosixPath(resolveHomeDirWithOsFallback(env)));
  if (isBootVolumeUserHome(home)) {
    return home;
  }
  // External-volume HOME: prefer the <shortName> parsed from the path itself
  // over env.USER/LOGNAME, which can be missing or stale in stripped envs.
  // Last-resort fallback to the original external HOME only happens when
  // neither the path matches `/.../Users/<name>` nor env supplies a name;
  // surfacing a diagnostic for that case is left to the install flow.
  const userName = extractUserNameFromHomePath(home) ?? resolveShortUserName(env);
  return userName ? path.posix.join("/Users", userName) : home;
}

export function resolveLaunchAgentPlistPathForLabel(
  env: LaunchAgentPathEnv,
  label: string,
): string {
  return path.posix.join(
    resolveLaunchAgentHomeDir(env),
    "Library",
    "LaunchAgents",
    `${label}.plist`,
  );
}
