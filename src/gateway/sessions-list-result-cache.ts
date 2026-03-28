import { getSubagentRegistryGeneration } from "../agents/subagent-registry.js";
import {
  createExpiringMapCache,
  isCacheEnabled,
  resolveCacheTtlMs,
} from "../config/cache-utils.js";
import {
  collectResolvedConfigSourceStatFingerprintSync,
  getConfigStatFingerprintAtLastLoad,
  getRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { getSessionStoreTtl } from "../config/sessions/store-cache.js";
import { parseStrictNonNegativeInteger } from "../infra/parse-finite-number.js";
import { getTranscriptWriteGeneration } from "../sessions/transcript-events.js";
import { buildSessionsListParamsKey } from "../shared/session-types.js";
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

export function getSessionsListResultCacheTtlMs(): number {
  return resolveCacheTtlMs({
    envValue: process.env.OPENCLAW_SESSIONS_LIST_RESULT_CACHE_TTL_MS,
    defaultTtlMs: getSessionStoreTtl(),
  });
}

const DEFAULT_SESSIONS_LIST_RESULT_CACHE_MAX_ENTRIES = 128;

/** Max cached list fingerprints; `OPENCLAW_SESSIONS_LIST_RESULT_CACHE_MAX_ENTRIES=0` disables the cap. */
export function getSessionsListResultCacheMaxEntries(): number | undefined {
  const raw = process.env.OPENCLAW_SESSIONS_LIST_RESULT_CACHE_MAX_ENTRIES;
  if (raw === undefined || raw === "") {
    return DEFAULT_SESSIONS_LIST_RESULT_CACHE_MAX_ENTRIES;
  }
  const parsed = parseStrictNonNegativeInteger(raw);
  if (parsed === undefined) {
    return DEFAULT_SESSIONS_LIST_RESULT_CACHE_MAX_ENTRIES;
  }
  if (parsed === 0) {
    return undefined;
  }
  return parsed;
}

const SESSIONS_LIST_RESULT_CACHE = createExpiringMapCache<string, CachedListPayload>({
  ttlMs: getSessionsListResultCacheTtlMs,
  maxEntries: getSessionsListResultCacheMaxEntries,
});

function cloneCachedListPayload(payload: CachedListPayload): CachedListPayload {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(payload);
  }
  return JSON.parse(JSON.stringify(payload)) as CachedListPayload;
}

export function isSessionsListResultCacheEnabled(): boolean {
  return isCacheEnabled(getSessionsListResultCacheTtlMs());
}

export function clearSessionsListResultCacheForTest(): void {
  SESSIONS_LIST_RESULT_CACHE.clear();
}

let sessionsListFullComputationHook: (() => void) | null = null;

/** Register a callback invoked once per `sessions.list` full-computation path. */
export function setSessionsListFullComputationHook(cb: (() => void) | null): void {
  sessionsListFullComputationHook = cb;
}

/** Notify that `sessions.list` executed a full computation (cache miss). */
export function notifySessionsListFullComputation(): void {
  sessionsListFullComputationHook?.();
}

/**
 * Transcript-backed fields and time windows need fresh reads; `activeMinutes` depends on `Date.now()`.
 *
 * Note: subagent `runtimeMs` in session rows is time-dependent during active runs, but the
 * subagent registry generation counter in the cache key ensures the cache is busted on any
 * spawn/release/sweep mutation. Between mutations, `runtimeMs` may drift by up to the cache TTL
 * (default ~45s) — acceptable since the UI recomputes live durations client-side from `startedAt`.
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

/**
 * Shared canonical key for the overlapping sessions-list fields used by both the gateway
 * and UI clients.
 */
function buildSessionsListResultCacheKey(params: {
  cfg: OpenClawConfig;
  listParams: SessionsListParams;
}): string {
  const storesFp = collectCombinedSessionStoreStatFingerprint(params.cfg);
  const cfgFp = collectResolvedConfigSourceStatFingerprintSync();
  const paramsKey = buildSessionsListParamsKey(params.listParams);
  const subagentGen = getSubagentRegistryGeneration();
  const txGen = getTranscriptWriteGeneration();
  // When the config stat fingerprint has advanced past what loadConfig() last
  // parsed, the cfg object may be stale (loadConfig has a ~200ms cache).
  // Including a staleness flag ensures entries written from a stale cfg are
  // not reused after loadConfig catches up to the on-disk state.
  const cfgFpAtLoad = getConfigStatFingerprintAtLastLoad();
  const cfgAligned = cfgFp === cfgFpAtLoad ? "y" : "n";
  return `${cfgFp}\n${storesFp}\nsagen:${subagentGen}\ntxgen:${txGen}\ncfga:${cfgAligned}\n${paramsKey}`;
}

export function tryReadSessionsListResultCache(params: {
  cfg: OpenClawConfig;
  listParams: SessionsListParams;
}): CachedListPayload | null {
  if (!isSessionsListResultCacheEligible(params.listParams)) {
    return null;
  }
  const key = buildSessionsListResultCacheKey(params);
  const cached = SESSIONS_LIST_RESULT_CACHE.get(key);
  return cached ? cloneCachedListPayload(cached) : null;
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
  const payload: CachedListPayload = {
    hash: params.hash,
    path: params.result.path,
    count: params.result.count,
    defaults: params.result.defaults,
    sessions: params.result.sessions,
  };
  SESSIONS_LIST_RESULT_CACHE.set(key, cloneCachedListPayload(payload));
}
