// Stale-while-revalidate cache for models.authStatus provider usage enrichment.
import { resolveApiKeyForProfile, type AuthProfileStore } from "../../agents/auth-profiles.js";
import { fingerprintAuthProfileCredential } from "../../agents/execution-auth-binding.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.load.js";
import { PROVIDER_USAGE_TIMEOUT_MS } from "../../infra/provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageSummary,
} from "../../infra/provider-usage.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { formatForLog } from "../ws-log.js";
import type { ModelAuthProfileUsage } from "./models-auth-status.types.js";
import {
  clearProviderUsageRuntimeSnapshot,
  getProviderUsageRuntimeSnapshot,
} from "./provider-usage-runtime.js";

const log = createSubsystemLogger("provider-usage-cache");
const USAGE_CACHE_TTL_MS = 60_000;

export type ProviderUsageStatus = Pick<
  ProviderUsageSnapshot,
  "windows" | "summary" | "plan" | "billing" | "accountEmail"
>;

type ProviderUsageCacheEntry = {
  agentDir: string;
  configRef: OpenClawConfig;
  credentialKey: string;
  providerKey: string;
  refreshedAt: number;
  summary: UsageSummary;
  usageByProvider: Map<string, ProviderUsageStatus>;
};

type ProviderUsageRefresh = {
  agentDir: string;
  configRef: OpenClawConfig;
  credentialKey: string;
  providerKey: string;
  promise: Promise<UsageSummary>;
};

const usageCacheByAgentId = new Map<string, ProviderUsageCacheEntry>();
const usageRefreshByAgentId = new Map<string, ProviderUsageRefresh>();
type ProfileUsageCacheEntry = {
  agentDir: string;
  configRef: OpenClawConfig;
  credentialKey: string;
  providerId: UsageProviderId;
  refreshedAt: number;
  usage: ModelAuthProfileUsage;
};

type ProfileUsageRefresh = Omit<ProfileUsageCacheEntry, "refreshedAt" | "usage"> & {
  promise: Promise<ModelAuthProfileUsage>;
};

// Profile quota must never bleed between accounts. The composite key is the
// smallest cache ownership boundary that survives unrelated profile changes.
const profileUsageCache = new Map<string, ProfileUsageCacheEntry>();
const profileUsageRefresh = new Map<string, ProfileUsageRefresh>();
let cacheGeneration = 0;

export function clearModelAuthStatusUsageCache(): void {
  cacheGeneration += 1;
  usageCacheByAgentId.clear();
  usageRefreshByAgentId.clear();
  profileUsageCache.clear();
  profileUsageRefresh.clear();
  clearProviderUsageRuntimeSnapshot();
}

function profileUsageCacheKey(agentId: string, profileId: string): string {
  return `${agentId}\0${profileId}`;
}

function mapProfileUsage(
  providerId: UsageProviderId,
  snapshot: ProviderUsageSnapshot | undefined,
): ModelAuthProfileUsage {
  if (!snapshot || snapshot.error) {
    return { status: "unavailable", providerId };
  }
  return {
    status: "ready",
    providerId,
    windows: snapshot.windows,
    ...(snapshot.summary ? { summary: snapshot.summary } : {}),
    ...(snapshot.plan ? { plan: snapshot.plan } : {}),
    ...(snapshot.billing?.length ? { billing: snapshot.billing } : {}),
    ...(snapshot.accountEmail ? { accountEmail: snapshot.accountEmail } : {}),
  };
}

function scheduleProfileUsageRefresh(params: {
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  authStore: AuthProfileStore;
  configRef: OpenClawConfig;
  profileId: string;
  providerId: UsageProviderId;
  credentialKey: string;
}): Promise<ModelAuthProfileUsage> {
  const key = profileUsageCacheKey(params.agentId, params.profileId);
  const active = profileUsageRefresh.get(key);
  if (
    active?.agentDir === params.agentDir &&
    active.configRef === params.configRef &&
    active.credentialKey === params.credentialKey &&
    active.providerId === params.providerId
  ) {
    return active.promise;
  }
  const publishGeneration = cacheGeneration;
  const promise = trackAsyncWork(async () => {
    const credential = params.authStore.profiles[params.profileId];
    if (!credential || credential.type !== "oauth") {
      return { status: "unavailable", providerId: params.providerId } as ModelAuthProfileUsage;
    }
    const resolved = await resolveApiKeyForProfile({
      cfg: params.configRef,
      store: params.authStore,
      profileId: params.profileId,
      agentDir: params.agentDir,
    });
    if (!resolved) {
      return { status: "unavailable", providerId: params.providerId } as ModelAuthProfileUsage;
    }
    const summary = await loadProviderUsageSummary({
      providers: [params.providerId],
      auth: [
        {
          provider: params.providerId,
          token: resolved.apiKey,
          authProfileId: params.profileId,
          ...(credential.accountId ? { accountId: credential.accountId } : {}),
          ...(credential.subscriptionType ? { subscriptionType: credential.subscriptionType } : {}),
          ...(credential.rateLimitTier ? { rateLimitTier: credential.rateLimitTier } : {}),
          ...(credential.email ? { email: credential.email } : {}),
        },
      ],
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      authStore: params.authStore,
      config: params.configRef,
      timeoutMs: PROVIDER_USAGE_TIMEOUT_MS,
    });
    return mapProfileUsage(
      params.providerId,
      summary.providers.find((provider) => provider.provider === params.providerId),
    );
  })
    .catch((err: unknown) => {
      log.debug(
        `profile usage refresh failed: profile=${params.profileId} provider=${params.providerId} error=${formatForLog(err)}`,
      );
      return { status: "unavailable", providerId: params.providerId } as ModelAuthProfileUsage;
    })
    .then((usage) => {
      if (publishGeneration === cacheGeneration && profileUsageRefresh.get(key) === refresh) {
        profileUsageCache.set(key, {
          agentDir: params.agentDir,
          configRef: params.configRef,
          credentialKey: params.credentialKey,
          providerId: params.providerId,
          refreshedAt: Date.now(),
          usage,
        });
      }
      return usage;
    })
    .finally(() => {
      if (profileUsageRefresh.get(key) === refresh) {
        profileUsageRefresh.delete(key);
      }
    });
  const refresh: ProfileUsageRefresh = {
    agentDir: params.agentDir,
    configRef: params.configRef,
    credentialKey: params.credentialKey,
    providerId: params.providerId,
    promise,
  };
  profileUsageRefresh.set(key, refresh);
  return promise;
}

/** Loads one OAuth account's quota under an agent+profile cache boundary. */
export async function loadProfileUsageStaleWhileRevalidate(params: {
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  authStore: AuthProfileStore;
  configRef: OpenClawConfig;
  profileId: string;
  providerId: UsageProviderId;
  forceRefresh?: boolean;
  now: number;
}): Promise<ModelAuthProfileUsage> {
  const credential = params.authStore.profiles[params.profileId];
  if (!credential || credential.type !== "oauth") {
    return { status: "unavailable", providerId: params.providerId };
  }
  const credentialKey =
    fingerprintAuthProfileCredential({ profileId: params.profileId, credential }) ??
    `${params.profileId}:${credential.provider}:${credential.type}`;
  const key = profileUsageCacheKey(params.agentId, params.profileId);
  const cached = profileUsageCache.get(key);
  const matching =
    cached?.agentDir === params.agentDir &&
    cached.configRef === params.configRef &&
    cached.credentialKey === credentialKey &&
    cached.providerId === params.providerId
      ? cached
      : undefined;
  const stale = !matching || params.now - matching.refreshedAt >= USAGE_CACHE_TTL_MS;
  if (!params.forceRefresh && matching && !stale) {
    return matching.usage;
  }
  const refresh = scheduleProfileUsageRefresh({ ...params, credentialKey });
  if (matching && !params.forceRefresh) {
    void refresh;
    return matching.usage;
  }
  return await refresh;
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

function mapProviderUsage(usage: Awaited<ReturnType<typeof loadProviderUsageSummary>>) {
  const usageByProvider = new Map<string, ProviderUsageStatus>();
  for (const snap of usage.providers) {
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

function scheduleProviderUsageRefresh(params: {
  agentId: string;
  agentDir: string;
  authStore?: AuthProfileStore;
  configRef: OpenClawConfig;
  credentialKey: string;
  providerIds: UsageProviderId[];
  providerKey: string;
  lastGood?: UsageSummary;
}): Promise<UsageSummary> {
  const active = usageRefreshByAgentId.get(params.agentId);
  if (
    active?.agentDir === params.agentDir &&
    active.configRef === params.configRef &&
    active.credentialKey === params.credentialKey &&
    active.providerKey === params.providerKey
  ) {
    return active.promise;
  }
  const publishGeneration = cacheGeneration;
  // SWR replies and invalidation must retain publication and finalization ownership.
  const promise = trackAsyncWork(() =>
    loadProviderUsageSummary({
      providers: params.providerIds,
      agentDir: params.agentDir,
      authStore: params.authStore,
      config: params.configRef,
      timeoutMs: PROVIDER_USAGE_TIMEOUT_MS,
    })
      .then((freshUsage) => {
        const usage = retainLastGoodOnTimeout(freshUsage, params.lastGood);
        if (
          publishGeneration === cacheGeneration &&
          usageRefreshByAgentId.get(params.agentId) === refresh
        ) {
          usageCacheByAgentId.set(params.agentId, {
            agentDir: params.agentDir,
            configRef: params.configRef,
            credentialKey: params.credentialKey,
            providerKey: params.providerKey,
            refreshedAt: Date.now(),
            summary: usage,
            usageByProvider: mapProviderUsage(usage),
          });
        }
        return usage;
      })
      .catch((err: unknown) => {
        // Usage is auxiliary and stale data remains valid. A failed refresh
        // publishes nothing, so a capable client keeps seeing the incomplete
        // marker and reports it once its retry budget is spent.
        log.debug(
          `usage refresh failed: providers=${params.providerIds.join(",")} error=${formatForLog(err)}`,
        );
        throw err;
      })
      .finally(() => {
        if (usageRefreshByAgentId.get(params.agentId) === refresh) {
          usageRefreshByAgentId.delete(params.agentId);
        }
      }),
  );
  const refresh: ProviderUsageRefresh = {
    agentDir: params.agentDir,
    configRef: params.configRef,
    credentialKey: params.credentialKey,
    providerKey: params.providerKey,
    promise,
  };
  usageRefreshByAgentId.set(params.agentId, refresh);
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
  const cached = usageCacheByAgentId.get(params.agentId);
  const matching =
    cached?.agentDir === params.agentDir &&
    cached.configRef === params.configRef &&
    cached.credentialKey === credentialKey &&
    cached.providerKey === providerKey
      ? cached
      : undefined;
  const needsRefresh =
    params.forceRefresh === true ||
    !matching ||
    params.now - matching.refreshedAt >= USAGE_CACHE_TTL_MS;
  return { credentialKey, matching, needsRefresh, providerIds, providerKey };
}

export function readProviderUsageStaleWhileRevalidate(
  params: ProviderUsageCacheParams,
): Map<string, ProviderUsageStatus> {
  if (params.providerIds.length === 0) {
    usageCacheByAgentId.delete(params.agentId);
    return new Map();
  }
  const { credentialKey, matching, needsRefresh, providerIds, providerKey } =
    resolveProviderUsageCacheRead(params);
  if (needsRefresh) {
    // Never couple the RPC deadline to provider HTTP. A cold call returns auth
    // without usage; stale calls return the last snapshot while one refresh runs.
    void scheduleProviderUsageRefresh({
      agentId: params.agentId,
      agentDir: params.agentDir,
      authStore: params.authStore,
      configRef: params.configRef,
      credentialKey,
      providerIds,
      providerKey,
      lastGood: matching?.summary,
    }).catch(() => {});
  }
  return matching?.usageByProvider ?? new Map();
}

/** Shares the models.authStatus cache contract with the unscoped usage.status RPC. */
export async function loadUsageStatusStaleWhileRevalidate(options: {
  config: OpenClawConfig;
  coldRead?: "refresh-marker";
  now?: number;
}): Promise<UsageSummary> {
  const snapshot = getProviderUsageRuntimeSnapshot({ config: options.config });
  const params: ProviderUsageCacheParams = {
    agentId: snapshot.agentId,
    agentDir: snapshot.agentDir,
    authStore: snapshot.store,
    configRef: snapshot.configRef,
    credentialKey: snapshot.credentialKey,
    providerIds: snapshot.providerIds,
    coldRead: options.coldRead,
    now: options.now ?? Date.now(),
  };
  if (params.providerIds.length === 0) {
    usageCacheByAgentId.delete(params.agentId);
    return { updatedAt: params.now, providers: [] };
  }
  const { credentialKey, matching, needsRefresh, providerIds, providerKey } =
    resolveProviderUsageCacheRead(params);
  if (matching && !needsRefresh) {
    return matching.summary;
  }
  const refresh = scheduleProviderUsageRefresh({
    agentId: params.agentId,
    agentDir: params.agentDir,
    authStore: params.authStore,
    configRef: params.configRef,
    credentialKey,
    providerIds,
    providerKey,
    lastGood: matching?.summary,
  });
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
