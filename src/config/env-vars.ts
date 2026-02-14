import type { OpenClawConfig } from "./types.js";

export function collectConfigEnvVars(cfg?: OpenClawConfig): Record<string, string> {
  const envConfig = cfg?.env;
  if (!envConfig) {
    return {};
  }

  const entries: Record<string, string> = {};

  if (envConfig.vars) {
    for (const [key, value] of Object.entries(envConfig.vars)) {
      if (!value) {
        continue;
      }
      entries[key] = value;
    }
  }

  for (const [key, value] of Object.entries(envConfig)) {
    if (key === "shellEnv" || key === "vars") {
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    entries[key] = value;
  }

  return entries;
}

export function applyConfigEnvVars(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const entries = collectConfigEnvVars(cfg);
  for (const [key, value] of Object.entries(entries)) {
    if (env[key]?.trim()) {
      continue;
    }
    env[key] = value;
  }
}
