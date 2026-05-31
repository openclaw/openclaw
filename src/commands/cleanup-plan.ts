import {
  getRuntimeConfig,
  resolveConfigPath,
  resolveOAuthDir,
  resolveStateDir,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildCleanupPlan } from "./cleanup-utils.js";

/**
 * Reads current runtime paths and builds the cleanup plan used by CLI cleanup flows.
 */
export function resolveCleanupPlanFromDisk(): {
  cfg: OpenClawConfig;
  stateDir: string;
  configPath: string;
  oauthDir: string;
  configInsideState: boolean;
  oauthInsideState: boolean;
  workspaceDirs: string[];
} {
  const cfg = getRuntimeConfig();
  const stateDir = resolveStateDir();
  const configPath = resolveConfigPath();
  const oauthDir = resolveOAuthDir();
  const plan = buildCleanupPlan({ cfg, stateDir, configPath, oauthDir });
  return { cfg, stateDir, configPath, oauthDir, ...plan };
}
