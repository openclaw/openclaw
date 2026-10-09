// Decides whether raw config is sufficient for static root help without loading config runtime.

import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveConfigReadDotEnvPaths } from "../infra/dotenv-paths.js";
import { resolveConfigPathCandidate } from "./paths.js";

const HELP_AFFECTING_ENV_KEYS = [
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;
const KNOWN_PLUGIN_LOAD_KEYS = new Set(["paths"]);
const KNOWN_PLUGIN_KEYS = new Set(["enabled", "allow", "deny", "load", "slots", "entries"]);

function hasDynamicConfigValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes("${") || value.includes("$(");
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasDynamicConfigValue(entry));
  }
  if (!isRecord(value)) {
    return false;
  }
  if (Object.hasOwn(value, "$include")) {
    return true;
  }
  return Object.values(value).some((entry) => hasDynamicConfigValue(entry));
}

function hasOnlyKnownKeys(value: Record<string, unknown>, known: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => known.has(key));
}

function hasNoListEntries(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

function hasNoRecordEntries(value: unknown): boolean {
  return value === undefined || (isRecord(value) && Object.keys(value).length === 0);
}

function pluginConfigKeepsRootHelpStatic(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKnownKeys(value, KNOWN_PLUGIN_KEYS)) {
    return false;
  }
  if (value.enabled !== undefined && value.enabled !== true) {
    return false;
  }
  if (!hasNoListEntries(value.allow) || !hasNoListEntries(value.deny)) {
    return false;
  }
  if (!hasNoRecordEntries(value.slots) || !hasNoRecordEntries(value.entries)) {
    return false;
  }
  if (value.load !== undefined) {
    if (!isRecord(value.load) || !hasOnlyKnownKeys(value.load, KNOWN_PLUGIN_LOAD_KEYS)) {
      return false;
    }
    if (!hasNoListEntries(value.load.paths)) {
      return false;
    }
  }
  return true;
}

export function canUsePrecomputedRootHelpWithoutLiveConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { cwd?: string; homedir?: () => string } = {},
): boolean {
  if (HELP_AFFECTING_ENV_KEYS.some((key) => env[key]?.trim())) {
    return false;
  }
  if (
    resolveConfigReadDotEnvPaths({
      env,
      homedir: options.homedir,
      ...(Object.hasOwn(options, "cwd") ? { cwd: options.cwd } : {}),
    }).some((filePath) => fs.existsSync(filePath))
  ) {
    return false;
  }

  try {
    const configPath = resolveConfigPathCandidate(env, options.homedir);
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (
      !isRecord(parsed) ||
      !Object.hasOwn(parsed, "plugins") ||
      Object.hasOwn(parsed, "env") ||
      hasDynamicConfigValue(parsed)
    ) {
      return false;
    }
    return pluginConfigKeepsRootHelpStatic(parsed.plugins);
  } catch {
    return false;
  }
}
