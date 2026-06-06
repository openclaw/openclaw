/** Resolves daemon state, home, and generated task-script paths. */
import fsSync from "node:fs";
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

/**
 * Home dir whose `Library/LaunchAgents` launchd should manage. When $HOME is on
 * an external APFS volume, launchd refuses to bootstrap plists from it (error 5:
 * I/O error), so fall back to the boot-volume home `/Users/<user>`. The plist
 * path, its uninstall trash target, and doctor's service scan all derive from
 * this single source so they stay on one volume and on the path launchd loaded.
 */
export function resolveLaunchAgentHomeDir(env: Record<string, string | undefined>): string {
  const home = resolveHomeDir(env);
  if (!isExternalVolumePathSync(home)) {
    return home;
  }
  // Derive the boot-volume home from HOME's own basename (case-preserving),
  // which is the user folder name; this always lands under /Users on the boot
  // volume regardless of env.USER casing or a sudo-changed USER.
  const user = path.basename(home);
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
