import path from "node:path";
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
    if (isPathKey(key)) {
      const envKey = resolveEnvKey(env, key) ?? key;
      const merged = mergePathValue(value, env[envKey]);
      if (merged) {
        env[envKey] = merged;
      }
      continue;
    }
    if (env[key]?.trim()) {
      continue;
    }
    env[key] = value;
  }
}

function isPathKey(key: string): boolean {
  return key.toLowerCase() === "path";
}

function resolveEnvKey(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(env, key)) {
    return key;
  }
  const lowerCaseKey = key.toLowerCase();
  for (const existingKey of Object.keys(env)) {
    if (existingKey.toLowerCase() === lowerCaseKey) {
      return existingKey;
    }
  }
  return undefined;
}

function mergePathValue(configValue: string, existingValue?: string): string {
  const configEntries = splitPathEntries(configValue);
  const existingEntries = splitPathEntries(existingValue ?? "");
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...configEntries, ...existingEntries]) {
    if (!seen.has(entry)) {
      seen.add(entry);
      merged.push(entry);
    }
  }
  return merged.join(path.delimiter);
}

function splitPathEntries(value: string): string[] {
  return value
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
}
