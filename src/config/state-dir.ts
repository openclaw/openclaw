// State-directory lookup without initializing process-wide config paths.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHomeRelativePath, resolveRequiredHomeDir } from "../infra/home-dir.js";
import { isFastTestRuntimeEnv } from "../infra/test-runtime-env.js";

export function resolveLegacyStateDirs(homedir: () => string = resolveRequiredHomeDir): string[] {
  return [path.join(homedir(), ".clawdbot")];
}

export function resolveNewStateDir(homedir: () => string = resolveRequiredHomeDir): string {
  return path.join(homedir(), ".openclaw");
}

/**
 * State directory for mutable data (sessions, logs, caches).
 * Can be overridden via OPENCLAW_STATE_DIR.
 * Default: ~/.openclaw
 */
export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): string {
  const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return resolveHomeRelativePath(override, { env, homedir: effectiveHomedir });
  }
  return resolveStateDirFromHome(env, effectiveHomedir);
}

/** Select a default state directory from the caller's already resolved home. */
export function resolveStateDirFromHome(
  env: NodeJS.ProcessEnv,
  effectiveHomedir: () => string,
): string {
  const newDir = resolveNewStateDir(effectiveHomedir);
  if (isFastTestRuntimeEnv(env) || fs.existsSync(newDir)) {
    return newDir;
  }
  return resolveLegacyStateDirs(effectiveHomedir).find((dir) => fs.existsSync(dir)) ?? newDir;
}
