// Resolves config-directory paths without initializing process-wide state.
import os from "node:os";
import path from "node:path";
import { resolveRequiredHomeDir, resolveUserPath } from "./home-dir.js";

/** Resolves the OpenClaw config directory from state/config env overrides or home. */
export function resolveConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env, homedir);
  }
  const configPath = env.OPENCLAW_CONFIG_PATH?.trim();
  if (configPath) {
    return path.dirname(resolveUserPath(configPath, env, homedir));
  }
  return path.join(resolveRequiredHomeDir(env, homedir), ".openclaw");
}
