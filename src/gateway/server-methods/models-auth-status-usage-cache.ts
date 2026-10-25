import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  ProviderUsageMetricsListener,
  ProviderUsageMetricsProvider,
  ProviderUsageMetricsRefreshOutcome,
  ProviderUsageMetricsSnapshot,
} from "../../infra/provider-usage-metrics.types.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.load.js";
import { PROVIDER_USAGE_TIMEOUT_MS } from "../../infra/provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageSummary,
} from "../../infra/provider-usage.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runOutsideAsyncWorkScope, trackAsyncWork } from "../../shared/async-work-scope.js";
import { formatForLog } from "../ws-log.js";
import {
  clearProviderUsageRuntimeSnapshot,
  getProviderUsageRuntimeSnapshot,
} from "./provider-usage-runtime.js";

const log = createSubsystemLogger("provider-usage-cache");
const DEFAULT_USAGE_CACHE_TTL_MS = 60_000;

export type ProviderUsageStatus = Pick<
  ProviderUsageSnapshot,
  "windows" | "summary" | "plan" | "billing" | "accountEmail"
>;

type ProviderUsageCacheIdentity = {
  agentDir: string;
  configRef: OpenClawConfig;
  credentialKey: string;
  providerKey: string;
};

type ProviderUsageCacheEntry = ProviderUsageCacheIdentity & {
  refreshedAt: number;
  summary: UsageSummary;
  usageByProvider: Map<string, ProviderUsageStatus>;
};

type ProviderUsageRefresh = ProviderUsageCacheIdentity & {
  promise: Promise<UsageSummary>;
  signal?: AbortSignal;
};

// models.authStatus polls refreshable credentials; usage.status polls every usage provider.
// Both read on one page load, so each agent keeps one entry per provider set.
const usageCacheByAgentId = new Map<string, Map<string, ProviderUsageCacheEntry>>();
const usageRefreshByAgentId = new Map<string, Map<string, ProviderUsageRefresh>>();

function agentEntries<T>(byAgentId: Map<string, Map<string, T>>, agentId: string) {
  let entries = byAgentId.get(agentId);
  if (!entries) {
    entries = new Map();
    byAgentId.set(agentId, entries);
  }
  return entries;
}

type UsageMetricsProjection = {
  generation: number;
  credentialKey: string;
  providers: Map<string, ProviderUsageMetricsProvider>;
};
type UsageMetricsListenerBinding = {
  listener: ProviderUsageMetricsListener;
  providerKey: string;
};
const usageMetricsByAgentId = new Map<string, Map<string, UsageMetricsProjection>>();
const usageMetricsListenersByAgentId = new Map<string, Set<UsageMetricsListenerBinding>>();
let cacheGeneration = 0;
let usageMetricsGeneration = 0;

const PROVIDER_USAGE_METRICS_REFRESH_INTERVAL_MS = 60_000;
const SAFE_METRIC_DIMENSION_RE = /^[A-Za-z0-9_.:-]{1,120}$/u;
const WINDOW_METRIC_DIMENSION_ALIASES = new Map([
  ["Tokens (6h)", "tokens_6h"],
  ["Tokens (15m)", "tokens_15m"],
  ["Tokens (Limit)", "tokens_limit"],
]);

function safeMetricDimension(value: string): string {
  const trimmed = value.trim();
  return SAFE_METRIC_DIMENSION_RE.test(trimmed) ? trimmed : "unknown";
}

function safeWindowMetricDimension(value: string): string {
  const trimmed = value.trim();
  return WINDOW_METRIC_DIMENSION_ALIASES.get(trimmed) ?? safeMetricDimension(trimmed);
}

function uniqueWindowMetricDimensions(windows: readonly { label: string }[]): string[] {
  const used = new Set<string>();
  return windows.map((window) => {
    const base = safeWindowMetricDimension(window.label);
    let dimension = base;
    let suffix = 2;
    while (used.has(dimension)) {
      const suffixText = `_${suffix}`;
      dimension = `${base.slice(0, 120 - suffixText.length)}${suffixText}`;
      suffix += 1;
    }
    used.add(dimension);
    return dimension;
  });
}

function providerUsageRefreshOutcome(
  error: string | undefined,
): ProviderUsageMetricsRefreshOutcome {
  if (!error) {
    return "success";
  }
  const normalized = error.toLowerCase();
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return "timeout";
  }
  if (
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    /(?:^|\D)429(?:\D|$)/u.test(normalized)
  ) {
    return "rate_limit";
  }
  if (
    normalized.includes("billing") ||
    normalized.includes("payment") ||
    normalized.includes("credit") ||
    /(?:^|\D)402(?:\D|$)/u.test(normalized)
  ) {
    return "billing";
  }
  if (
    normalized.includes("unauthor") ||
    normalized.includes("forbidden") ||
    normalized.includes("credential") ||
    normalized.includes("oauth") ||
    normalized.includes("token") ||
    /(?:^|\D)(?:401|403)(?:\D|$)/u.test(normalized)
  ) {
    return "auth";
  }
  if (
    normalized.includes("malformed") ||
    normalized.includes("parse") ||
    normalized.includes("invalid response") ||
    normalized.includes("unexpected response")
  ) {
    return "format";
  }
  return "unknown";
}

function usageMetricsSnapshot(agentId: string, providerKey: string): ProviderUsageMetricsSnapshot {
  const state = usageMetricsByAgentId.get(agentId)?.get(providerKey);
  return {
    generation: state?.generation ?? usageMetricsGeneration,
    providers: [...(state?.providers.values() ?? [])].toSorted((left, right) =>
      left.provider.localeCompare(right.provider),
    ),
  };
}

function publishUsageMetrics(agentId: string, providerKey: string): void {
  const listeners = usageMetricsListenersByAgentId.get(agentId);
  if (!listeners || listeners.size === 0) {
    return;
  }
  const snapshot = usageMetricsSnapshot(agentId, providerKey);
  for (const binding of listeners) {
    if (binding.providerKey !== providerKey) {
      continue;
    }
    try {
      binding.listener(snapshot);
    } catch (err) {
      log.debug(`provider usage metrics listener failed: ${formatForLog(err)}`);
    }
  }
}

function reconcileUsageMetricsSelection(params: {
  agentId: string;
  credentialKey: string;
  providerKey: string;
}): void {
  const projections = agentEntries(usageMetricsByAgentId, params.agentId);
  const current = projections.get(params.providerKey);
  if (current?.credentialKey === params.credentialKey) {
    return;
  }
  usageMetricsGeneration += 1;
  projections.set(params.providerKey, {
    generation: usageMetricsGeneration,
    credentialKey: params.credentialKey,
    providers: new Map(),
  });
  // Credential changes withdraw this provider set only. Other sets stay intact.
  publishUsageMetrics(params.agentId, params.providerKey);
}

function recordProviderUsageMetricsRefresh(params: {
  agentId: string;
  attemptAt: number;
  credentialKey: string;
  error?: unknown;
  providerIds: readonly UsageProviderId[];
  providerKey: string;
  summary?: UsageSummary;
}): void {
  const state = usageMetricsByAgentId.get(params.agentId)?.get(params.providerKey);
  if (!state || state.credentialKey !== params.credentialKey) {
    return;
  }
  const snapshots = new Map(
    (params.summary?.providers ?? []).map((provider) => [provider.provider, provider]),
  );
  const completedAt = Date.now();
  for (const providerId of params.providerIds) {
    const provider = safeMetricDimension(providerId);
    const snapshot = snapshots.get(providerId);
    const outcome = snapshot
      ? providerUsageRefreshOutcome(snapshot.error)
      : params.error
        ? providerUsageRefreshOutcome(formatForLog(params.error))
        : "unknown";
    const previous = state.providers.get(provider);
    const succeeded = snapshot !== undefined && outcome === "success";
    const windowDimensions = snapshot ? uniqueWindowMetricDimensions(snapshot.windows) : [];
    state.providers.set(provider, {
      provider,
      windows: succeeded
        ? snapshot.windows.map((window, index) =>
            window.resetAt === undefined
              ? {
                  window: windowDimensions[index] ?? "unknown",
                  usedRatio: Math.min(1, Math.max(0, window.usedPercent / 100)),
                }
              : {
                  window: windowDimensions[index] ?? "unknown",
                  usedRatio: Math.min(1, Math.max(0, window.usedPercent / 100)),
                  resetTimestampSeconds: window.resetAt / 1000,
                },
          )
        : (previous?.windows ?? []),
      lastAttemptTimestampSeconds: params.attemptAt / 1000,
      ...(succeeded
        ? { lastSuccessTimestampSeconds: completedAt / 1000 }
        : previous?.lastSuccessTimestampSeconds !== undefined
          ? { lastSuccessTimestampSeconds: previous.lastSuccessTimestampSeconds }
          : {}),
      refreshSuccess: succeeded,
      refreshOutcome: outcome,
    });
  }
  publishUsageMetrics(params.agentId, params.providerKey);
}

export function clearModelAuthStatusUsageCache(): void {
  cacheGeneration += 1;
  usageCacheByAgentId.clear();
  usageRefreshByAgentId.clear();
  usageMetricsGeneration += 1;
  for (const [agentId, projections] of usageMetricsByAgentId) {
    for (const providerKey of projections.keys()) {
      projections.delete(providerKey);
      publishUsageMetrics(agentId, providerKey);
    }
    usageMetricsByAgentId.delete(agentId);
  }
  clearProviderUsageRuntimeSnapshot();
}

function scopeProviderUsageCredentialKey(
  credentialKey: string,
  providerIds: readonly UsageProviderId[],
): string {
  // models.authStatus fingerprints every direct provider. Scope that evidence to
  // this fetch set so usage.status can share the same credential-bound snapshot.
  // SAFETY: fingerprintProviderUsageCredentials always serializes this shape.
  const parsed = JSON.parse(credentialKey) as {
    direct: Array<[string, string | null]>;
    [key: string]: unknown;
  };
  const providers = new Set(providerIds);
  return JSON.stringify({
    ...parsed,
    direct: parsed.direct.filter(
      ([provider, fingerprint]) => providers.has(provider) && fingerprint !== null,
    ),
  });
}

function mapProviderUsage(usage: UsageSummary, previous?: Map<string, ProviderUsageStatus>) {
  const usageByProvider = new Map<string, ProviderUsageStatus>();
  for (const snap of usage.providers) {
    // Auth status has no usage-error field. Keep its last quota while usage.status
    // still receives the provider's error in the unmodified summary.
    const retained = snap.error ? previous?.get(snap.provider) : undefined;
    if (retained) {
      usageByProvider.set(snap.provider, retained);
      continue;
    }
    usageByProvider.set(snap.provider, {
      windows: snap.windows,
      ...(snap.summary ? { summary: snap.summary } : {}),
      ...(snap.plan ? { plan: snap.plan } : {}),
      ...(snap.billing?.length ? { billing: snap.billing } : {}),
      ...(snap.accountEmail ? { accountEmail: snap.accountEmail } : {}),
    });
  }
  return usageByProvider;
}

function retainLastGoodOnTimeout(
  summary: UsageSummary,
  lastGood: UsageSummary | undefined,
): UsageSummary {
  if (!lastGood) {
    return summary;
  }
  const lastGoodByProvider = new Map(
    lastGood.providers
      .filter((provider) => provider.error === undefined)
      .map((provider) => [provider.provider, provider]),
  );
  const retainedLastGood = summary.providers.some(
    (provider) => provider.error === "Timeout" && lastGoodByProvider.has(provider.provider),
  );
  return {
    ...summary,
    updatedAt: retainedLastGood ? lastGood.updatedAt : summary.updatedAt,
    providers: summary.providers.map((provider) =>
      provider.error === "Timeout"
        ? (lastGoodByProvider.get(provider.provider) ?? provider)
        : provider,
    ),
  };
}

function scheduleProviderUsageRefresh(
  params: ProviderUsageCacheIdentity & {
    agentId: string;
    authStore?: AuthProfileStore;
    providerIds: UsageProviderId[];
    previous?: ProviderUsageCacheEntry;
    signal?: AbortSignal;
  },
): Promise<UsageSummary> {
  params.signal?.throwIfAborted();
  const isCurrent = () =>
    usageRefreshByAgentId.get(params.agentId)?.get(params.providerKey) === refresh;
  const active = usageRefreshByAgentId.get(params.agentId)?.get(params.providerKey);
  if (
    active?.agentDir === params.agentDir &&
    active.configRef === params.configRef &&
    active.credentialKey === params.credentialKey &&
    active.providerKey === params.providerKey &&
    (active.signal === undefined || active.signal === params.signal)
  ) {
    return active.promise;
  }
  reconcileUsageMetricsSelection(params);
  const attemptAt = Date.now();
  const publishGeneration = cacheGeneration;
  // SWR replies and invalidation must retain publication and finalization ownership.
  const promise = trackAsyncWork(() =>
    loadProviderUsageSummary({
      providers: params.providerIds,
      agentDir: params.agentDir,
      authStore: params.authStore,
      config: params.configRef,
      timeoutMs: PROVIDER_USAGE_TIMEOUT_MS,
      ...(params.signal ? { signal: params.signal } : {}),
    })
      .then((freshUsage) => {
        const usage = retainLastGoodOnTimeout(freshUsage, params.previous?.summary);
        if (publishGeneration === cacheGeneration && isCurrent()) {
          recordProviderUsageMetricsRefresh({
            agentId: params.agentId,
            attemptAt,
            credentialKey: params.credentialKey,
            providerIds: params.providerIds,
            providerKey: params.providerKey,
            summary: freshUsage,
          });
          agentEntries(usageCacheByAgentId, params.agentId).set(params.providerKey, {
            agentDir: params.agentDir,
            configRef: params.configRef,
            credentialKey: params.credentialKey,
            providerKey: params.providerKey,
            refreshedAt: Date.now(),
            summary: usage,
            usageByProvider: mapProviderUsage(usage, params.previous?.usageByProvider),
          });
        }
        return usage;
      })
      .catch((err: unknown) => {
        if (
          publishGeneration === cacheGeneration &&
          usageRefreshByAgentId.get(params.agentId)?.get(params.providerKey) === refresh
        ) {
          recordProviderUsageMetricsRefresh({
            agentId: params.agentId,
            attemptAt,
            credentialKey: params.credentialKey,
            error: err,
            providerIds: params.providerIds,
            providerKey: params.providerKey,
          });
        }
        // Usage is auxiliary and stale data remains valid. A failed refresh
        // publishes nothing, so a capable client keeps seeing the incomplete
        // marker and reports it once its retry budget is spent.
        log.debug(
          `usage refresh failed: providers=${params.providerIds.join(",")} error=${formatForLog(err)}`,
        );
        throw err;
      })
      .finally(() => {
        if (isCurrent()) {
          usageRefreshByAgentId.get(params.agentId)?.delete(params.providerKey);
        }
      }),
  );
  const refresh: ProviderUsageRefresh = {
    agentDir: params.agentDir,
    configRef: params.configRef,
    credentialKey: params.credentialKey,
    providerKey: params.providerKey,
    promise,
    ...(params.signal ? { signal: params.signal } : {}),
  };
  agentEntries(usageRefreshByAgentId, params.agentId).set(params.providerKey, refresh);
  return promise;
}

type ProviderUsageCacheParams = {
  agentId: string;
  agentDir: string;
  authStore?: AuthProfileStore;
  configRef: OpenClawConfig;
  credentialKey: string;
  coldRead?: "refresh-marker";
  forceRefresh?: boolean;
  providerIds: UsageProviderId[];
  now: number;
};

function resolveProviderUsageCacheRead(params: ProviderUsageCacheParams) {
  const providerIds = params.providerIds.toSorted();
  const providerKey = providerIds.join("\0");
  const credentialKey = scopeProviderUsageCredentialKey(params.credentialKey, providerIds);
  const cached = usageCacheByAgentId.get(params.agentId)?.get(providerKey);
  const matching =
    cached?.agentDir === params.agentDir &&
    cached.configRef === params.configRef &&
    cached.credentialKey === credentialKey
      ? cached
      : undefined;
  const needsRefresh =
    params.forceRefresh === true ||
    !matching ||
    params.now - matching.refreshedAt >=
      (params.configRef.models?.usage?.cacheTtlMs ?? DEFAULT_USAGE_CACHE_TTL_MS);
  return {
    matching,
    needsRefresh,
    refreshParams: {
      agentId: params.agentId,
      agentDir: params.agentDir,
      authStore: params.authStore,
      configRef: params.configRef,
      credentialKey,
      providerIds,
      providerKey,
      previous: matching,
    },
  };
}

/** Ordinary reads stay nonblocking; post-run reads await only cold or stale usage. */
export async function readProviderUsage(
  params: ProviderUsageCacheParams & { awaitRefresh?: boolean },
): Promise<{ usageByProvider: Map<string, ProviderUsageStatus>; refreshAt?: number }> {
  if (params.providerIds.length === 0) {
    usageCacheByAgentId.delete(params.agentId);
    return { usageByProvider: new Map() };
  }
  const { matching, needsRefresh, refreshParams } = resolveProviderUsageCacheRead(params);
  let published = matching;
  if (needsRefresh) {
    const refresh = scheduleProviderUsageRefresh(refreshParams);
    if (params.awaitRefresh) {
      const usage = await refresh;
      const failed = usage.providers.find((provider) => provider.error);
      if (failed) {
        throw new Error(`Provider usage refresh failed for ${failed.provider}. Try again later.`);
      }
      // Logout or credential replacement can retire an in-flight publication.
      published = resolveProviderUsageCacheRead(params).matching;
    } else {
      void refresh.catch(() => {});
    }
  }
  return {
    usageByProvider: published?.usageByProvider ?? new Map(),
    refreshAt: published
      ? published.refreshedAt +
        (params.configRef.models?.usage?.cacheTtlMs ?? DEFAULT_USAGE_CACHE_TTL_MS)
      : params.now,
  };
}

/** Shares the models.authStatus cache contract with the unscoped usage.status RPC. */
export async function loadUsageStatusStaleWhileRevalidate(options: {
  config: OpenClawConfig;
  coldRead?: "refresh-marker";
}): Promise<UsageSummary> {
  const snapshot = await getProviderUsageRuntimeSnapshot({ config: options.config });
  const params: ProviderUsageCacheParams = {
    agentId: snapshot.agentId,
    agentDir: snapshot.agentDir,
    authStore: snapshot.store,
    configRef: snapshot.configRef,
    credentialKey: snapshot.credentialKey,
    providerIds: snapshot.providerIds,
    coldRead: options.coldRead,
    now: Date.now(),
  };
  if (params.providerIds.length === 0) {
    usageCacheByAgentId.delete(params.agentId);
    return { updatedAt: params.now, providers: [] };
  }
  const { matching, needsRefresh, refreshParams } = resolveProviderUsageCacheRead(params);
  if (matching && !needsRefresh) {
    return matching.summary;
  }
  const refresh = scheduleProviderUsageRefresh(refreshParams);
  if (matching) {
    void refresh.catch(() => {});
    return matching.summary;
  }
  if (params.coldRead !== "refresh-marker") {
    return await refresh;
  }
  void refresh.catch(() => {});
  return { updatedAt: params.now, providers: [], refreshing: true };
}
/**
 * Observes privacy-safe allowance snapshots owned by the default-agent usage cache.
 * The returned lease schedules refreshes; listeners and Prometheus scrapes never fetch providers.
 */
export function observeProviderUsageMetrics(params: {
  getConfig: () => OpenClawConfig;
  listener: ProviderUsageMetricsListener;
  refreshIntervalMs?: number;
}): () => void {
  const authority = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let agentId: string | undefined;

  const removeListener = (targetAgentId: string | undefined) => {
    if (!targetAgentId) {
      return;
    }
    const listeners = usageMetricsListenersByAgentId.get(targetAgentId);
    for (const binding of listeners ?? []) {
      if (binding.listener === params.listener) {
        listeners?.delete(binding);
      }
    }
    if (listeners?.size === 0) {
      usageMetricsListenersByAgentId.delete(targetAgentId);
    }
  };

  const refresh = async () => {
    const refreshStartedAt = Date.now();
    try {
      const snapshot = await getProviderUsageRuntimeSnapshot({ config: params.getConfig() });
      // Release can race the async runtime snapshot. Do not publish the listener after
      // its owner has already revoked the observer lease.
      if (stopped || authority.signal.aborted) {
        return;
      }
      if (agentId !== snapshot.agentId) {
        removeListener(agentId);
      }
      agentId = snapshot.agentId;
      const { refreshParams } = resolveProviderUsageCacheRead({
        agentId,
        agentDir: snapshot.agentDir,
        authStore: snapshot.store,
        configRef: snapshot.configRef,
        credentialKey: snapshot.credentialKey,
        providerIds: snapshot.providerIds,
        forceRefresh: true,
        now: Date.now(),
      });
      reconcileUsageMetricsSelection({
        agentId,
        credentialKey: refreshParams.credentialKey,
        providerKey: refreshParams.providerKey,
      });
      let listeners = usageMetricsListenersByAgentId.get(agentId);
      if (!listeners) {
        listeners = new Set();
        usageMetricsListenersByAgentId.set(agentId, listeners);
      }
      for (const binding of listeners) {
        if (binding.listener === params.listener) {
          listeners.delete(binding);
        }
      }
      listeners.add({ listener: params.listener, providerKey: refreshParams.providerKey });
      publishUsageMetrics(agentId, refreshParams.providerKey);
      await scheduleProviderUsageRefresh({
        ...refreshParams,
        signal: authority.signal,
      });
    } catch (err) {
      log.debug(`provider usage metrics refresh failed: ${formatForLog(err)}`);
    } finally {
      if (!stopped) {
        const refreshIntervalMs =
          params.refreshIntervalMs ?? PROVIDER_USAGE_METRICS_REFRESH_INTERVAL_MS;
        const nextRefreshDelayMs = Math.max(0, refreshIntervalMs - (Date.now() - refreshStartedAt));
        // This observer outlives the plugin-start or config-reload scope that created it.
        // Do not let recurring timers retain that scope after it has drained and closed.
        timer = runOutsideAsyncWorkScope(() =>
          setTimeout(() => void refresh(), nextRefreshDelayMs),
        );
        timer.unref?.();
      }
    }
  };

  void refresh();
  return () => {
    stopped = true;
    authority.abort(new DOMException("Provider usage observer released", "AbortError"));
    clearTimeout(timer);
    removeListener(agentId);
  };
}
