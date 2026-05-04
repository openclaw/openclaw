import { resolveRuntimeConfigCacheKey } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionsListParams } from "./protocol/index.js";
import { listSessionsFromStoreAsync } from "./session-utils.js";

const SESSIONS_LIST_RESULT_CACHE_TTL_MS = 60_000;
const SESSIONS_LIST_RESULT_CACHE_MAX = 24;

type SessionsListResult = Awaited<ReturnType<typeof listSessionsFromStoreAsync>>;

type SessionsListInFlightEntry = {
  generation: number;
  promise: Promise<SessionsListResult>;
};

const sessionsListResultCache = new Map<string, { storedAt: number; result: SessionsListResult }>();
const sessionsListInFlight = new Map<string, SessionsListInFlightEntry>();
let sessionsListCacheGeneration = 0;

function normalizeSessionsListCacheValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

export function buildSessionsListCacheKey(params: {
  cfg: OpenClawConfig;
  storePath: string;
  opts: SessionsListParams;
}): string {
  const p = params.opts;
  return JSON.stringify({
    config: resolveRuntimeConfigCacheKey(params.cfg),
    storePath: params.storePath,
    agentId: normalizeSessionsListCacheValue(p.agentId),
    activeMinutes: normalizeSessionsListCacheValue(p.activeMinutes),
    limit: normalizeSessionsListCacheValue(p.limit),
    includeGlobal: normalizeSessionsListCacheValue(p.includeGlobal),
    includeUnknown: normalizeSessionsListCacheValue(p.includeUnknown),
    spawnedBy: normalizeSessionsListCacheValue(p.spawnedBy),
    label: normalizeSessionsListCacheValue(p.label),
    search: normalizeSessionsListCacheValue(p.search),
    includeDerivedTitles: normalizeSessionsListCacheValue(p.includeDerivedTitles),
    includeLastMessage: normalizeSessionsListCacheValue(p.includeLastMessage),
  });
}

export function invalidateSessionsListResultCache(): void {
  sessionsListCacheGeneration += 1;
  sessionsListResultCache.clear();
  sessionsListInFlight.clear();
}

function readCachedSessionsListResult(cacheKey: string): SessionsListResult | undefined {
  const cached = sessionsListResultCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  if (Date.now() - cached.storedAt > SESSIONS_LIST_RESULT_CACHE_TTL_MS) {
    sessionsListResultCache.delete(cacheKey);
    return undefined;
  }
  return cached.result;
}

function writeCachedSessionsListResult(cacheKey: string, result: SessionsListResult): void {
  if (sessionsListResultCache.size >= SESSIONS_LIST_RESULT_CACHE_MAX) {
    const oldestKey = sessionsListResultCache.keys().next().value;
    if (oldestKey !== undefined) {
      sessionsListResultCache.delete(oldestKey);
    }
  }
  sessionsListResultCache.set(cacheKey, { storedAt: Date.now(), result });
}

export async function loadSessionsListResultCached(
  cacheKey: string,
  load: () => Promise<SessionsListResult>,
): Promise<SessionsListResult> {
  const cached = readCachedSessionsListResult(cacheKey);
  if (cached) {
    return cached;
  }
  const inflight = sessionsListInFlight.get(cacheKey);
  if (inflight) {
    return await inflight.promise;
  }
  const generation = sessionsListCacheGeneration;
  const promise = load();
  sessionsListInFlight.set(cacheKey, { generation, promise });
  try {
    const result = await promise;
    if (sessionsListCacheGeneration === generation) {
      writeCachedSessionsListResult(cacheKey, result);
    }
    return result;
  } finally {
    const current = sessionsListInFlight.get(cacheKey);
    if (current?.promise === promise) {
      sessionsListInFlight.delete(cacheKey);
    }
  }
}
