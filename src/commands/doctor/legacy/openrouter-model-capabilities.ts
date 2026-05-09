import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  parseOpenRouterModelCapabilitiesCachePayload,
  writeOpenRouterModelCapabilitiesCacheForMigration,
  type OpenRouterModelCapabilities,
} from "../../../agents/pi-embedded-runner/openrouter-model-capabilities.js";
import { resolveStateDir } from "../../../config/paths.js";

const LEGACY_JSON_CACHE_FILENAME = "openrouter-models.json";

function resolveLegacyJsonCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveStateDir(env), "cache");
}

function resolveLegacyJsonCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveLegacyJsonCacheDir(env), LEGACY_JSON_CACHE_FILENAME);
}

function readLegacyJsonCache(
  env: NodeJS.ProcessEnv = process.env,
): Map<string, OpenRouterModelCapabilities> | undefined {
  try {
    const cachePath = resolveLegacyJsonCachePath(env);
    if (!existsSync(cachePath)) {
      return undefined;
    }
    return parseOpenRouterModelCapabilitiesCachePayload(
      JSON.parse(readFileSync(cachePath, "utf-8")) as unknown,
    );
  } catch {
    return undefined;
  }
}

export function legacyOpenRouterModelCapabilitiesCacheExists(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return existsSync(resolveLegacyJsonCachePath(env));
}

export function importLegacyOpenRouterModelCapabilitiesCacheToSqlite(
  env: NodeJS.ProcessEnv = process.env,
): { imported: boolean; models: number } {
  if (!legacyOpenRouterModelCapabilitiesCacheExists(env)) {
    return { imported: false, models: 0 };
  }
  const legacyJsonCache = readLegacyJsonCache(env);
  if (legacyJsonCache) {
    writeOpenRouterModelCapabilitiesCacheForMigration(legacyJsonCache, env);
  }
  try {
    unlinkSync(resolveLegacyJsonCachePath(env));
  } catch {
    // Import succeeded; a later doctor pass can remove the stale file.
  }
  return { imported: true, models: legacyJsonCache?.size ?? 0 };
}
