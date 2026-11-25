// State-directory lookup without initializing process-wide config paths.
import os from "node:os";
import path from "node:path";
import { normalizeProfileName, resolveProfileStateDir } from "../cli/profile-utils.js";
import { resolveHomeRelativePath, resolveRequiredHomeDir } from "../infra/home-dir.js";
import { LruCache } from "../infra/lru-cache.js";

const absoluteStateDirs = new LruCache<string>(64);

export function resolveLegacyStateDirs(homedir: () => string = resolveRequiredHomeDir): string[] {
  return [path.join(homedir(), ".clawdbot")];
}

export function resolveNewStateDir(homedir: () => string = resolveRequiredHomeDir): string {
  return path.join(homedir(), ".openclaw");
}

/**
 * State directory for mutable data (sessions, logs, caches).
 * Can be overridden via OPENCLAW_STATE_DIR.
 * Default: ~/.openclaw, or ~/.openclaw-<profile> for a named profile.
 */
export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  // Startup pins this absolute override. Other forms still observe home, cwd,
  // and the updater's invocation base; Windows rooted paths can depend on a drive cwd.
  if (override && process.platform !== "win32" && path.isAbsolute(override)) {
    const cached = absoluteStateDirs.peek(override);
    if (cached !== undefined) {
      return cached;
    }
    const resolved = path.resolve(override);
    absoluteStateDirs.set(override, resolved);
    return resolved;
  }
  if (override) {
    return resolveHomeRelativePath(override, { env, homedir });
  }
  return resolveStateDirFromHome(env, () => resolveRequiredHomeDir(env, homedir));
}

/** Select a default state directory from the caller's already resolved home. */
export function resolveStateDirFromHome(
  env: NodeJS.ProcessEnv,
  effectiveHomedir: () => string,
): string {
  const profile = normalizeProfileName(env.OPENCLAW_PROFILE);
  return profile
    ? resolveProfileStateDir(profile, env, effectiveHomedir)
    : resolveNewStateDir(effectiveHomedir);
}
