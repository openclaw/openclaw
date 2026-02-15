import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { ProviderUsageSnapshot } from "./provider-usage.types.js";

const CACHE_FILE = "provider-usage-cache.json";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

type UsageCache = {
  updatedAt: number;
  providers: Record<string, ProviderUsageSnapshot>;
};

function getCachePath(): string {
  const stateDir = resolveStateDir();
  return path.join(stateDir, CACHE_FILE);
}

export function loadUsageCache(): UsageCache | null {
  try {
    const cachePath = getCachePath();
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, "utf-8");
    const cache = JSON.parse(raw) as UsageCache;
    // Check if cache is still valid
    if (Date.now() - cache.updatedAt > CACHE_TTL_MS) {
      return null;
    }
    return cache;
  } catch {
    return null;
  }
}

export function saveUsageCache(provider: string, snapshot: ProviderUsageSnapshot): void {
  try {
    const cachePath = getCachePath();
    let cache: UsageCache;
    try {
      const raw = fs.readFileSync(cachePath, "utf-8");
      cache = JSON.parse(raw) as UsageCache;
    } catch {
      cache = { updatedAt: 0, providers: {} };
    }
    cache.providers[provider] = snapshot;
    cache.updatedAt = Date.now();
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  } catch {
    // Ignore cache write errors
  }
}

export function getCachedUsage(provider: string): ProviderUsageSnapshot | null {
  const cache = loadUsageCache();
  if (!cache) return null;
  return cache.providers[provider] ?? null;
}
