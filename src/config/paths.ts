import os from "node:os";
import path from "node:path";

import type { ClawdisConfig } from "./types.js";

/**
 * Nix mode detection: When CLAWDIS_NIX_MODE=1, the gateway is running under Nix.
 * In this mode:
 * - No auto-install flows should be attempted
 * - Missing dependencies should produce actionable Nix-specific error messages
 * - Config is managed externally (read-only from Nix perspective)
 */
export function resolveIsNixMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.CLAWDIS_NIX_MODE === "1";
}

export const isNixMode = resolveIsNixMode();

/**
 * State directory for mutable data (sessions, logs, caches).
 * Can be overridden via CLAWDIS_STATE_DIR environment variable.
 * Default: ~/.clawdis
 */
export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = env.CLAWDIS_STATE_DIR?.trim();
  if (override) return override;
  return path.join(homedir(), ".clawdis");
}

export const STATE_DIR_CLAWDIS = resolveStateDir();

/**
 * Config file path (JSON5).
 * Can be overridden via CLAWDIS_CONFIG_PATH environment variable.
 * Default: ~/.clawdis/clawdis.json (or $CLAWDIS_STATE_DIR/clawdis.json)
 */
export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, os.homedir),
): string {
  const override = env.CLAWDIS_CONFIG_PATH?.trim();
  if (override) return override;
  return path.join(stateDir, "clawdis.json");
}

export const CONFIG_PATH_CLAWDIS = resolveConfigPath();

export const DEFAULT_GATEWAY_PORT = 18789;

export function resolveGatewayPort(
  cfg?: ClawdisConfig,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const envRaw = env.CLAWDIS_GATEWAY_PORT?.trim();
  if (envRaw) {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const configPort = cfg?.gateway?.port;
  if (typeof configPort === "number" && Number.isFinite(configPort)) {
    if (configPort > 0) return configPort;
  }
  return DEFAULT_GATEWAY_PORT;
}
