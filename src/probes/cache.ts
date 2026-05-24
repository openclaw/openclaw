import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/**
 * Probe Cache - Isolated storage for channel/health probe results.
 *
 * This cache keeps probe snapshots separate from gateway readiness state.
 * Slow channel probes (like Telegram) do not block core gateway readiness.
 *
 * Key features:
 * - Separate from gateway readiness checks
 * - TTL-based expiration
 * - Non-blocking: cached results returned immediately if available
 * - Background refresh for stale entries
 */

export const PROBE_CACHE_DIRNAME = "probe-cache";
export const PROBE_CACHE_TTL_MS = 60_000; // 1 minute default TTL
export const PROBE_CACHE_STALE_MS = 30_000; // Consider stale after 30s

export type ProbeCacheEntry<T = unknown> = {
  id: string;
  type: "channel" | "gateway" | "plugin" | "task" | "lock";
  timestamp: string;
  ttlMs: number;
  result: T;
  error?: string;
  durationMs?: number;
};

export type ProbeCacheOptions = {
  ttlMs?: number;
  config?: OpenClawConfig;
};

function resolveProbeCacheDir(_config?: OpenClawConfig): string {
  const stateDir = resolveStateDir();
  const cacheDir = path.join(stateDir, PROBE_CACHE_DIRNAME);
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  return cacheDir;
}

function resolveProbeCachePath(type: string, id: string, config?: OpenClawConfig): string {
  const cacheDir = resolveProbeCacheDir(config);
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(cacheDir, `${type}-${safeId}.json`);
}

function readProbeCacheEntry<T>(
  type: string,
  id: string,
  config?: OpenClawConfig,
): ProbeCacheEntry<T> | null {
  const cachePath = resolveProbeCachePath(type, id, config);
  if (!fs.existsSync(cachePath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(cachePath, "utf-8");
    const entry = JSON.parse(content) as ProbeCacheEntry<T>;
    const timestamp = new Date(entry.timestamp).getTime();
    const age = Date.now() - timestamp;
    if (age > entry.ttlMs) {
      // Expired - remove and return null
      fs.unlinkSync(cachePath);
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

function writeProbeCacheEntry<T>(entry: ProbeCacheEntry<T>, config?: OpenClawConfig): void {
  const cachePath = resolveProbeCachePath(entry.type, entry.id, config);
  fs.writeFileSync(cachePath, JSON.stringify(entry, null, 2), "utf-8");
}

export function getCachedProbe<T>(
  type: ProbeCacheEntry["type"],
  id: string,
  config?: OpenClawConfig,
): {
  entry: ProbeCacheEntry<T> | null;
  isStale: boolean;
} {
  const entry = readProbeCacheEntry<T>(type, id, config);
  if (!entry) {
    return { entry: null, isStale: false };
  }
  const timestamp = new Date(entry.timestamp).getTime();
  const age = Date.now() - timestamp;
  const isStale = age > PROBE_CACHE_STALE_MS;
  return { entry, isStale };
}

export function setCachedProbe<T>(
  type: ProbeCacheEntry["type"],
  id: string,
  result: T,
  options?: ProbeCacheOptions & { error?: string; durationMs?: number },
): ProbeCacheEntry<T> {
  const entry: ProbeCacheEntry<T> = {
    id,
    type,
    timestamp: new Date().toISOString(),
    ttlMs: options?.ttlMs ?? PROBE_CACHE_TTL_MS,
    result,
    error: options?.error,
    durationMs: options?.durationMs,
  };
  writeProbeCacheEntry(entry, options?.config);
  return entry;
}

export function clearCachedProbe(
  type: ProbeCacheEntry["type"],
  id: string,
  config?: OpenClawConfig,
): void {
  const cachePath = resolveProbeCachePath(type, id, config);
  if (fs.existsSync(cachePath)) {
    fs.unlinkSync(cachePath);
  }
}

export function clearAllCachedProbes(
  type?: ProbeCacheEntry["type"],
  config?: OpenClawConfig,
): void {
  const cacheDir = resolveProbeCacheDir(config);
  const files = fs.readdirSync(cacheDir);
  for (const file of files) {
    if (type) {
      if (file.startsWith(`${type}-`)) {
        fs.unlinkSync(path.join(cacheDir, file));
      }
    } else {
      fs.unlinkSync(path.join(cacheDir, file));
    }
  }
}

export function listCachedProbes(
  config?: OpenClawConfig,
): Array<{ type: string; id: string; timestamp: string; stale: boolean }> {
  const cacheDir = resolveProbeCacheDir(config);
  const files = fs.readdirSync(cacheDir);
  const results: Array<{ type: string; id: string; timestamp: string; stale: boolean }> = [];
  for (const file of files) {
    const match = file.match(/^([a-z]+)-(.+)\.json$/);
    if (!match) {
      continue;
    }
    const [, type, id] = match;
    const cachePath = path.join(cacheDir, file);
    try {
      const content = fs.readFileSync(cachePath, "utf-8");
      const entry = JSON.parse(content) as ProbeCacheEntry;
      const timestamp = new Date(entry.timestamp).getTime();
      const age = Date.now() - timestamp;
      results.push({
        type,
        id,
        timestamp: entry.timestamp,
        stale: age > PROBE_CACHE_STALE_MS,
      });
    } catch {
      // ignore parse errors
    }
  }
  return results;
}

/**
 * Staggered execution with jitter and backoff.
 * Used to prevent thundering herd on channel probes.
 */

export type StaggerOptions = {
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  backoffFactor?: number;
  maxAttempts?: number;
};

const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 10_000;
const DEFAULT_JITTER_MS = 50;
const DEFAULT_BACKOFF_FACTOR = 2;

export function calculateStaggerDelay(attempt: number, options?: StaggerOptions): number {
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitterMs = options?.jitterMs ?? DEFAULT_JITTER_MS;
  const backoffFactor = options?.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;

  const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * backoffFactor ** (attempt - 1));
  const jitter = Math.random() * jitterMs;
  return Math.floor(exponentialDelay + jitter);
}

export async function staggerDelay(attempt: number, options?: StaggerOptions): Promise<number> {
  const delayMs = calculateStaggerDelay(attempt, options);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return delayMs;
}

export type ProbeExecutor<T> = () => Promise<T>;

export interface ProbeResult<T> {
  result: T;
  cached: boolean;
  stale: boolean;
  durationMs: number;
}

export async function executeWithCacheAndStagger<T>(
  type: ProbeCacheEntry["type"],
  id: string,
  executor: ProbeExecutor<T>,
  options?: ProbeCacheOptions & StaggerOptions & { forceRefresh?: boolean },
): Promise<ProbeResult<T>> {
  // Check cache first (unless force refresh)
  if (!options?.forceRefresh) {
    const { entry, isStale } = getCachedProbe<T>(type, id, options?.config);
    if (entry) {
      if (entry.error) {
        throw new Error(`Cached ${type} probe ${id} failed: ${entry.error}`);
      }
      // Return cached result, but mark if stale (caller may choose to background refresh)
      return {
        result: entry.result,
        cached: true,
        stale: isStale,
        durationMs: entry.durationMs ?? 0,
      };
    }
  }

  // Calculate stagger delay based on channel/probe type
  const attempt = 1;
  const delayMs = calculateStaggerDelay(attempt, options);

  // Apply stagger delay before executing
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const startTime = Date.now();
  try {
    const result = await executor();
    const durationMs = Date.now() - startTime;

    // Cache successful result
    setCachedProbe(type, id, result, {
      ...options,
      durationMs,
    });

    return {
      result,
      cached: false,
      stale: false,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const error = err instanceof Error ? err.message : String(err);

    // Cache error result with shorter TTL
    setCachedProbe(type, id, null as T, {
      ...options,
      ttlMs: Math.min(5000, options?.ttlMs ?? PROBE_CACHE_TTL_MS),
      error,
      durationMs,
    });

    throw err;
  }
}

/**
 * Batch probe executor with concurrency and stagger.
 * Runs probes in parallel batches with stagger between batches.
 */

export async function executeProbesWithStagger<T>(
  items: Array<{ type: ProbeCacheEntry["type"]; id: string; executor: ProbeExecutor<T> }>,
  options?: {
    concurrency?: number;
    staggerMs?: number;
    cacheConfig?: OpenClawConfig;
    skipCache?: boolean;
  },
): Promise<Map<string, ProbeResult<T>>> {
  const concurrency = options?.concurrency ?? 5;
  const staggerMs = options?.staggerMs ?? 100;

  const results = new Map<string, ProbeResult<T>>();

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);

    // Execute batch in parallel
    const batchResults = await Promise.allSettled(
      batch.map(async (item) => {
        const result = await executeWithCacheAndStagger(item.type, item.id, item.executor, {
          config: options?.cacheConfig,
          forceRefresh: options?.skipCache,
        });
        return { id: item.id, result };
      }),
    );

    for (const [idx, settled] of batchResults.entries()) {
      if (settled.status === "fulfilled") {
        results.set(settled.value.id, settled.value.result);
      } else {
        const item = batch[idx];
        if (!item) {
          continue;
        }
        results.set(item.id, {
          result: null as T,
          cached: false,
          stale: false,
          durationMs: 0,
        });
      }
    }

    // Stagger between batches (but not after last batch)
    if (i + concurrency < items.length && staggerMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, staggerMs));
    }
  }

  return results;
}

export { resolveProbeCacheDir };
