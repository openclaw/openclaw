import type { OpenClawConfig, HookConfig } from "../config/config.js";
import {
  evaluateRuntimeEligibility,
  hasBinary,
  isConfigPathTruthyWithDefaults,
} from "../shared/config-eval.js";
import { resolveHookConfig, resolveHookEnableState } from "./policy.js";
import type { HookPolicyEntry } from "./types.js";

const DEFAULT_CONFIG_VALUES: Record<string, boolean> = {
  "browser.enabled": true,
  "browser.evaluateEnabled": true,
  "workspace.dir": true,
};

export { hasBinary };

/** Evaluate a config path with hook-specific defaults for legacy runtime requirements. */
export function isHookConfigPathTruthy(
  config: OpenClawConfig | undefined,
  pathStr: string,
): boolean {
  return isConfigPathTruthyWithDefaults(config, pathStr, DEFAULT_CONFIG_VALUES);
}

export { resolveHookConfig };

export function isHookEnvSatisfied(envName: string, hookConfig?: HookConfig): boolean {
  return Boolean(process.env[envName]?.trim() || hookConfig?.env?.[envName]?.trim());
}

export function shouldIncludeHook(params: {
  entry: HookPolicyEntry;
  config?: OpenClawConfig;
}): boolean {
  const { entry, config } = params;
  const hookConfig = resolveHookConfig(config, entry.metadata?.hookKey ?? entry.hook.name);
  if (!resolveHookEnableState({ entry, hookConfig }).enabled) {
    return false;
  }

  // Hook metadata uses the same requirement language as plugins, but hook env
  // can also come from the per-hook config block.
  return evaluateRuntimeEligibility({
    os: entry.metadata?.os,
    always: entry.metadata?.always,
    requires: entry.metadata?.requires,
    hasBin: hasBinary,
    hasEnv: (envName) => isHookEnvSatisfied(envName, hookConfig),
    isConfigPathTruthy: (configPath) => isHookConfigPathTruthy(config, configPath),
  });
}
