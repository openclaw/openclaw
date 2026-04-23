import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LoggingConfig } from "../config/types.base.js";
import { resolveNodeRequireFromMeta } from "./node-require.js";

type ConfigModule = {
  loadConfig?: () => {
    logging?: unknown;
  };
  readBestEffortConfig?: () => unknown;
};
type ConfigModuleResolver = (id: string) => unknown;

const defaultResolveModule = resolveNodeRequireFromMeta(import.meta.url);
const MODULE_DIR_PATH = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_TREE_CONFIG_MODULE_SPECIFIER = "../config/config.js";
// Some flattened builds keep a stable config.js alias beside config-loader.js.
// When that alias is absent or points at the wrong chunk, fall back to hashed
// sibling discovery below.
const FLATTENED_DIST_CONFIG_MODULE_SPECIFIER = "./config.js";
const KNOWN_CONFIG_MODULE_SPECIFIERS = [
  SOURCE_TREE_CONFIG_MODULE_SPECIFIER,
  FLATTENED_DIST_CONFIG_MODULE_SPECIFIER,
] as const;
const HASHED_FLATTENED_CONFIG_MODULE_BASENAME_RE = /^config-[A-Za-z0-9_-]+\.js$/u;
let cachedDefaultConfigModule: ConfigModule | null | undefined;

function isConfigModule(value: unknown): value is ConfigModule {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as ConfigModule).loadConfig === "function" &&
    typeof (value as ConfigModule).readBestEffortConfig === "function"
  );
}

function isLoggingConfig(value: unknown): value is LoggingConfig {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCandidateConfigChunk(fileName: string): boolean {
  return (
    HASHED_FLATTENED_CONFIG_MODULE_BASENAME_RE.test(fileName) &&
    !fileName.startsWith("config-loader-")
  );
}

function listFlattenedConfigModuleSpecifiers(): string[] {
  try {
    return fs
      .readdirSync(MODULE_DIR_PATH, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isCandidateConfigChunk(entry.name))
      .map((entry) => `./${entry.name}`)
      .toSorted((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function resolveConfigModule(
  resolveModule: ConfigModuleResolver | null = defaultResolveModule,
): ConfigModule | undefined {
  const canUseCache = resolveModule === defaultResolveModule;
  if (canUseCache && cachedDefaultConfigModule !== undefined) {
    return cachedDefaultConfigModule ?? undefined;
  }
  if (!resolveModule) {
    if (canUseCache) {
      cachedDefaultConfigModule = null;
    }
    return undefined;
  }
  for (const specifier of [
    ...KNOWN_CONFIG_MODULE_SPECIFIERS,
    ...listFlattenedConfigModuleSpecifiers(),
  ]) {
    try {
      const loaded = resolveModule(specifier) as ConfigModule | undefined;
      if (isConfigModule(loaded)) {
        if (canUseCache) {
          cachedDefaultConfigModule = loaded;
        }
        return loaded;
      }
    } catch {
      // Try the next known package layout.
    }
  }
  if (canUseCache) {
    cachedDefaultConfigModule = null;
  }
  return undefined;
}

export function readBestEffortLoggingConfig(
  resolveModule?: ConfigModuleResolver | null,
): LoggingConfig | undefined {
  try {
    const logging = resolveConfigModule(resolveModule)?.loadConfig?.().logging;
    return isLoggingConfig(logging) ? logging : undefined;
  } catch {
    return undefined;
  }
}
