import { getSubagentRegistryGeneration } from "../agents/subagent-registry.js";
import {
  createExpiringMapCache,
  isCacheEnabled,
  resolveCacheTtlMs,
} from "../config/cache-utils.js";
import {
  collectResolvedConfigSourceStatFingerprintSync,
  getRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { getSessionStoreTtl } from "../config/sessions/store-cache.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getTranscriptWriteGeneration } from "../sessions/transcript-events.js";
import type { SessionsListParams } from "./protocol/index.js";
import { collectCombinedSessionStoreStatFingerprint } from "./session-utils.js";
import type { GatewaySessionsDefaults, SessionsListResult } from "./session-utils.types.js";

type CachedListPayload = {
  hash: string;
  path: string;
  count: number;
  defaults: GatewaySessionsDefaults;
  sessions: SessionsListResult["sessions"];
};

const SESSIONS_LIST_RESULT_CACHE = createExpiringMapCache<string, CachedListPayload>({
  ttlMs: getSessionsListResultCacheTtlMs,
});

export function getSessionsListResultCacheTtlMs(): number {
  return resolveCacheTtlMs({
    envValue: process.env.OPENCLAW_SESSIONS_LIST_RESULT_CACHE_TTL_MS,
    defaultTtlMs: getSessionStoreTtl(),
  });
}

export function isSessionsListResultCacheEnabled(): boolean {
  return isCacheEnabled(getSessionsListResultCacheTtlMs());
}

export function clearSessionsListResultCacheForTest(): void {
  SESSIONS_LIST_RESULT_CACHE.clear();
}

let sessionsListFullComputationTallyForTest = 0;

/** Test-only: increments once per `sessions.list` path that runs `listSessionsFromStore`. */
export function bumpSessionsListFullComputationForTest(): void {
  sessionsListFullComputationTallyForTest += 1;
}

export function getSessionsListFullComputationForTest(): number {
  return sessionsListFullComputationTallyForTest;
}

export function resetSessionsListFullComputationForTest(): void {
  sessionsListFullComputationTallyForTest = 0;
}

/**
 * Transcript-backed fields and time windows need fresh reads; `activeMinutes` depends on `Date.now()`.
 */
export function isSessionsListResultCacheEligible(params: SessionsListParams): boolean {
  if (!isSessionsListResultCacheEnabled()) {
    return false;
  }
  if (getRuntimeConfigSnapshot()) {
    return false;
  }
  if (params.includeDerivedTitles === true || params.includeLastMessage === true) {
    return false;
  }
  if (typeof params.activeMinutes === "number" && Number.isFinite(params.activeMinutes)) {
    return false;
  }
  return true;
}

function buildSessionsListParamsKey(params: SessionsListParams): string {
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit))
      : undefined;
  const label = typeof params.label === "string" ? params.label.trim() : "";
  const spawnedBy = typeof params.spawnedBy === "string" ? params.spawnedBy : "";
  const agentId = typeof params.agentId === "string" ? normalizeAgentId(params.agentId) : "";
  const search = typeof params.search === "string" ? params.search.trim().toLowerCase() : "";
  return JSON.stringify({
    limit,
    includeGlobal: params.includeGlobal === true,
    includeUnknown: params.includeUnknown === true,
    label,
    spawnedBy,
    agentId,
    search,
  });
}

function buildSessionsListResultCacheKey(params: {
  cfg: OpenClawConfig;
  listParams: SessionsListParams;
}): string {
  const storesFp = collectCombinedSessionStoreStatFingerprint(params.cfg);
  const cfgFp = collectResolvedConfigSourceStatFingerprintSync();
  const paramsKey = buildSessionsListParamsKey(params.listParams);
  const subagentGen = getSubagentRegistryGeneration();
  const txGen = getTranscriptWriteGeneration();
  return `${cfgFp}\n${storesFp}\nsagen:${subagentGen}\ntxgen:${txGen}\n${paramsKey}`;
}

export function tryReadSessionsListResultCache(params: {
  cfg: OpenClawConfig;
  listParams: SessionsListParams;
}): CachedListPayload | null {
  if (!isSessionsListResultCacheEligible(params.listParams)) {
    return null;
  }
  const key = buildSessionsListResultCacheKey(params);
  return SESSIONS_LIST_RESULT_CACHE.get(key) ?? null;
}

export function writeSessionsListResultCache(params: {
  cfg: OpenClawConfig;
  listParams: SessionsListParams;
  hash: string;
  result: SessionsListResult;
}): void {
  if (!isSessionsListResultCacheEligible(params.listParams)) {
    return;
  }
  const key = buildSessionsListResultCacheKey(params);
  SESSIONS_LIST_RESULT_CACHE.set(key, {
    hash: params.hash,
    path: params.result.path,
    count: params.result.count,
    defaults: params.result.defaults,
    sessions: params.result.sessions,
  });
}
