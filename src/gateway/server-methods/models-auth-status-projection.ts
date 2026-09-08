import {
  findNormalizedProviderKey,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type {
  AuthProfileHealthStatus,
  AuthProviderHealth,
  AuthProviderHealthStatus,
} from "../../agents/auth-health.js";
import { formatRemainingShort } from "../../agents/auth-health.js";
import {
  type AuthProfileStore,
  resolveAuthProfileMetadata,
  resolveExplicitAuthOrderSelection,
  type RuntimeAuthProfileStore,
} from "../../agents/auth-profiles.js";
import {
  type ProviderAuthAliasLookupParams,
  resolveProviderIdForAuth,
} from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/config.js";
import { providerUsageLabel, resolveUsageProviderId } from "../../infra/provider-usage.shared.js";
import type { ProviderUsageStatus } from "./models-auth-status-usage-cache.js";
import type {
  ModelAuthExpiry,
  ModelAuthProfileUsage,
  ModelAuthStatusProfile,
  ModelAuthStatusProvider,
} from "./models-auth-status.types.js";

// UI expiry fields are emitted only when both timestamp and remaining duration
// are valid, keeping profile/provider expiry shapes all-or-nothing.
function buildExpiry(
  remainingMs: number | undefined,
  expiresAt: number | undefined,
): ModelAuthExpiry | undefined {
  const normalizedExpiresAt = asDateTimestampMs(expiresAt);
  if (normalizedExpiresAt === undefined || typeof remainingMs !== "number") {
    return undefined;
  }
  return { at: normalizedExpiresAt, remainingMs, label: formatRemainingShort(remainingMs) };
}

function providerDisplayName(provider: string): string {
  const usageId = resolveUsageProviderId(provider);
  const usageLabel = usageId ? providerUsageLabel(usageId) : undefined;
  return usageLabel || provider;
}

type ModelAuthStatusRollup = {
  status: AuthProviderHealthStatus;
  expiresAt?: number;
  remainingMs?: number;
};

function aggregateProfileStatus(
  profiles: AuthProviderHealth["profiles"],
  now: number,
): ModelAuthStatusRollup {
  const statuses = new Set<AuthProfileHealthStatus>(profiles.map((profile) => profile.status));
  const status = (["expired", "missing", "expiring", "ok", "static"] as const).find((candidate) =>
    statuses.has(candidate),
  );
  const expirable = profiles
    .map((profile) => profile.expiresAt)
    .filter((value): value is number => asDateTimestampMs(value) !== undefined);
  const expiresAt = expirable.length > 0 ? Math.min(...expirable) : undefined;
  const remainingMs = expiresAt !== undefined ? expiresAt - now : undefined;
  return { status: status ?? "static", expiresAt, remainingMs };
}

/** Aggregates the effective refreshable credentials; OAuth remains authoritative. */
export function aggregateRefreshableAuthStatus(
  provider: AuthProviderHealth,
  now: number = Date.now(),
  expectsOAuth = false,
): ModelAuthStatusRollup {
  const profiles = provider.effectiveProfiles ?? provider.profiles;
  const oauth = profiles.filter((profile) => profile.type === "oauth");
  if (oauth.length > 0) {
    return aggregateProfileStatus(oauth, now);
  }
  const tokens = profiles.filter((profile) => profile.type === "token");
  if (tokens.length > 0) {
    return aggregateProfileStatus(tokens, now);
  }
  if (expectsOAuth) {
    return { status: "missing" };
  }
  return {
    status: provider.status,
    expiresAt: provider.expiresAt,
    remainingMs: provider.remainingMs,
  };
}

function projectProfileUsageIdentity(
  usage: ModelAuthProfileUsage,
  includeProfileIdentity: boolean,
): ModelAuthProfileUsage {
  if (includeProfileIdentity || !usage.accountEmail) {
    return usage;
  }
  const redacted = { ...usage };
  delete redacted.accountEmail;
  return redacted;
}

export function mapModelAuthStatusProvider(params: {
  provider: AuthProviderHealth;
  cfg: OpenClawConfig;
  store: AuthProfileStore;
  authAliasLookupParams: ProviderAuthAliasLookupParams;
  usageByProvider: Map<string, ProviderUsageStatus>;
  expectsOAuthSet: Set<string>;
  apiKeys: ReadonlyMap<string, ModelAuthStatusProvider["apiKey"]>;
  logoutProfileIds: ReadonlySet<string>;
  configBoundProfileIds: ReadonlySet<string>;
  configBoundAuthProviders: ReadonlySet<string>;
  externalProfileIds: ReadonlySet<string>;
  externalCliProfileIds: ReadonlySet<string>;
  includeProfileIdentity: boolean;
  profileUsageById: ReadonlyMap<string, ModelAuthProfileUsage>;
}): ModelAuthStatusProvider {
  const { provider } = params;
  const providerKey = normalizeProviderId(provider.provider);
  const authProviderKey = resolveProviderIdForAuth(provider.provider, params.authAliasLookupParams);
  const profileOrder = resolveExplicitAuthOrderSelection({
    storeOrder: params.store.order,
    configuredOrder: params.cfg.auth?.order,
    providerKey,
    providerAuthKey: authProviderKey,
  });
  const runtimeStore: RuntimeAuthProfileStore = params.store;
  const storedOrderKey =
    findNormalizedProviderKey(params.store.order, authProviderKey) ??
    findNormalizedProviderKey(params.store.order, providerKey);
  const localOrderStored =
    storedOrderKey !== undefined &&
    runtimeStore.runtimeLocalOrderProviderIds?.includes(storedOrderKey);
  const localProfileIds = new Set(
    runtimeStore.runtimeLocalProfileIds ??
      Object.keys(params.store.profiles).filter(
        (profileId) => !params.externalProfileIds.has(profileId),
      ),
  );
  const providerOrderLocked = params.configBoundAuthProviders.has(authProviderKey);
  const configuredOrderLocked = profileOrder.order !== undefined && !profileOrder.fromStore;
  const usageProfile =
    provider.profiles.find((profile) => profile.type === "oauth" || profile.type === "token") ??
    provider.profiles.find((profile) => profile.type === "api_key");
  const usageKey = resolveUsageProviderId(provider.provider, {
    credentialType: usageProfile?.type,
  });
  const usage = usageKey ? params.usageByProvider.get(usageKey) : undefined;
  const rawRollup = aggregateRefreshableAuthStatus(
    provider,
    Date.now(),
    params.expectsOAuthSet.has(provider.provider),
  );
  const effectiveProfiles = provider.effectiveProfiles ?? provider.profiles;
  const refreshableProfiles = effectiveProfiles.filter(
    (profile) => profile.type === "oauth" || profile.type === "token",
  );
  // External CLI access tokens rotate without operator action. Keep their raw
  // profile expiry diagnostic, but do not turn it into a provider login warning.
  const externalCliOwnsOAuthRefresh =
    refreshableProfiles.length > 0 &&
    refreshableProfiles.every(
      (profile) => profile.type === "oauth" && params.externalCliProfileIds.has(profile.profileId),
    );
  const rollup: ModelAuthStatusRollup =
    externalCliOwnsOAuthRefresh &&
    (rawRollup.status === "expired" || rawRollup.status === "expiring")
      ? { status: "ok" }
      : rawRollup;
  const apiKey = params.apiKeys.get(normalizeProviderId(provider.provider));
  const hasRefreshableProfile = provider.profiles.some(
    (profile) => profile.type === "oauth" || profile.type === "token",
  );
  return {
    provider: provider.provider,
    authProvider: authProviderKey,
    displayName: providerDisplayName(provider.provider),
    status:
      apiKey && !hasRefreshableProfile && rollup.status === "missing" ? "static" : rollup.status,
    expiry: buildExpiry(rollup.remainingMs, rollup.expiresAt),
    profiles: provider.profiles.map((profile) => {
      const metadata = resolveAuthProfileMetadata({
        cfg: params.cfg,
        store: params.store,
        profileId: profile.profileId,
      });
      const lastUsedAt = params.store.usageStats?.[profile.profileId]?.lastUsed;
      const profileUsage = params.profileUsageById.get(profile.profileId);
      const projected: ModelAuthStatusProfile = {
        profileId: profile.profileId,
        type: profile.type,
        status: profile.status,
        reasonCode: profile.reasonCode,
        source: params.configBoundProfileIds.has(profile.profileId)
          ? "config"
          : params.externalProfileIds.has(profile.profileId)
            ? "external"
            : localProfileIds.has(profile.profileId)
              ? "saved"
              : "inherited",
        expiry: buildExpiry(profile.remainingMs, profile.expiresAt),
      };
      if (params.externalCliProfileIds.has(profile.profileId)) {
        projected.externallyManaged = true;
      }
      if (params.includeProfileIdentity && metadata.displayName) {
        projected.displayName = metadata.displayName;
      }
      if (params.includeProfileIdentity && metadata.email) {
        projected.email = metadata.email;
      }
      if (params.includeProfileIdentity && lastUsedAt) {
        projected.lastUsedAt = lastUsedAt;
      }
      if (profileUsage) {
        projected.usage = projectProfileUsageIdentity(profileUsage, params.includeProfileIdentity);
      }
      if (
        (profile.type === "oauth" || profile.type === "token") &&
        params.logoutProfileIds.has(profile.profileId) &&
        !params.configBoundProfileIds.has(profile.profileId)
      ) {
        projected.logoutSupported = true;
      }
      return projected;
    }),
    ...(profileOrder.order !== undefined ? { profileOrder: profileOrder.order } : {}),
    ...(profileOrder.fromStore && localOrderStored ? { profileOrderStored: true } : {}),
    ...(providerOrderLocked
      ? { profileOrderLocked: "provider-config" as const }
      : configuredOrderLocked
        ? { profileOrderLocked: "auth-config" as const }
        : {}),
    ...(apiKey ? { apiKey } : {}),
    usage:
      usage && usageKey
        ? {
            providerId: usageKey,
            windows: usage.windows,
            ...(usage.summary ? { summary: usage.summary } : {}),
            ...(usage.plan ? { plan: usage.plan } : {}),
            ...(usage.billing?.length ? { billing: usage.billing } : {}),
            ...(params.includeProfileIdentity && usage.accountEmail
              ? { accountEmail: usage.accountEmail }
              : {}),
          }
        : undefined,
  };
}
