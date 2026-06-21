/** Resolves daemon state, home, and generated task-script paths. */
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveGatewayProfileSuffix } from "./constants.js";

const windowsAbsolutePath = /^[a-zA-Z]:[\\/]/;
const windowsUncPath = /^\\\\/;

/** Resolves the home directory used for daemon state paths. */
export function resolveHomeDir(env: Record<string, string | undefined>): string {
  const home = normalizeOptionalString(env.HOME) || normalizeOptionalString(env.USERPROFILE);
  if (!home) {
    throw new Error("Missing HOME");
  }
  return home;
}

// A path's volume is process-stable, so cache the one decision we make per run
// (single slot) rather than re-statting on every status/restart poll.
let externalVolumeMemo: { path: string; external: boolean } | undefined;

/** Whether targetPath lives on a different volume than the root filesystem. */
function isExternalVolumePathSync(targetPath: string): boolean {
  if (externalVolumeMemo?.path === targetPath) {
    return externalVolumeMemo.external;
  }
  let external = false;
  try {
    external = fsSync.statSync("/").dev !== fsSync.statSync(targetPath).dev;
  } catch {
    // If stat fails, conservatively keep the same-volume default above.
  }
  externalVolumeMemo = { path: targetPath, external };
  return external;
}

// The boot-volume account name comes from the login identity, not from HOME's
// structure: an external $HOME may be the volume root itself (e.g.
// `/Volumes/MainDataDrive`, the shape in issue #60398) whose last path segment
// is the volume name, not the user. USER/LOGNAME are case-preserved; fall back
// to the process owner when the launchd-sanitized env drops them.
function resolveLoginUsername(env: Record<string, string | undefined>): string | undefined {
  const fromEnv = normalizeOptionalString(env.USER) || normalizeOptionalString(env.LOGNAME);
  if (fromEnv) {
    return fromEnv;
  }
  try {
    return normalizeOptionalString(os.userInfo().username);
  } catch {
    return undefined;
  }
}

/**
 * Home dir whose `Library/LaunchAgents` launchd should manage. When $HOME is on
 * an external APFS volume, launchd refuses to bootstrap plists from it (error 5:
 * I/O error), so fall back to the boot-volume home `/Users/<login-user>`. The
 * plist path, its uninstall trash target, and doctor's service scan all derive
 * from this single source so they stay on one volume and on the path launchd
 * loaded. Keeps $HOME when the login user is undeterminable (no worse than the
 * pre-fix behavior).
 */
export function resolveLaunchAgentHomeDir(env: Record<string, string | undefined>): string {
  const home = resolveHomeDir(env);
  if (!isExternalVolumePathSync(home)) {
    return home;
  }
  const user = resolveLoginUsername(env);
  return user ? path.join(path.sep, "Users", user) : home;
}

function resolveUserPathWithHome(input: string, home?: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    if (!home) {
      throw new Error("Missing HOME");
    }
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, home);
    return path.resolve(expanded);
  }
  if (windowsAbsolutePath.test(trimmed) || windowsUncPath.test(trimmed)) {
    // Do not path.resolve Windows paths on POSIX hosts during cross-platform
    // service rendering; it would corrupt drive and UNC prefixes.
    return trimmed;
  }
  return path.resolve(trimmed);
}

export function resolveGatewayStateDir(env: Record<string, string | undefined>): string {
  const override = normalizeOptionalString(env.OPENCLAW_STATE_DIR);
  if (override) {
    const home = override.startsWith("~") ? resolveHomeDir(env) : undefined;
    return resolveUserPathWithHome(override, home);
  }
  const home = resolveHomeDir(env);
  const suffix = resolveGatewayProfileSuffix(env.OPENCLAW_PROFILE);
  // Profile suffixes isolate managed service files while preserving the default
  // historical ~/.openclaw state path.
  return path.join(home, `.openclaw${suffix}`);
}

export function resolveGatewayTaskScriptPath(env: Record<string, string | undefined>): string {
  const override = normalizeOptionalString(env.OPENCLAW_TASK_SCRIPT);
  if (override) {
    return override;
  }
  const scriptName = normalizeOptionalString(env.OPENCLAW_TASK_SCRIPT_NAME) || "gateway.cmd";
  if (/[/\\]|\.\./.test(scriptName)) {
    throw new Error(
      `OPENCLAW_TASK_SCRIPT_NAME must be a file name only, not a path: ${scriptName}`,
    );
  }
  return path.join(resolveGatewayStateDir(env), scriptName);
}
