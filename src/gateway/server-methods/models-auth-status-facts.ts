import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  buildAuthHealthSummary,
  DEFAULT_OAUTH_WARN_MS,
  type AuthHealthSummary,
} from "../../agents/auth-health.js";
import { DEFAULT_OAUTH_REFRESH_MARGIN_MS } from "../../agents/auth-profiles/credential-state.js";
import { isExternalCliAuthProfileInScope } from "../../agents/auth-profiles/external-cli-sync.js";
import { getRuntimeExternalCliProfileIds } from "../../agents/auth-profiles/runtime-external-profile-references.js";
import { getRuntimeAuthProfileStoreSnapshotsRevision } from "../../agents/auth-profiles/runtime-snapshots.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { isNonSecretApiKeyMarker } from "../../agents/model-auth-markers.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/config.js";
import { hasConfiguredSecretInput } from "../../config/types.secrets.js";
import { resolveUsageProviderId } from "../../infra/provider-usage.shared.js";
import type { UsageProviderId } from "../../infra/provider-usage.types.js";
import { NON_ENV_SECRETREF_MARKER } from "../../secrets/provider-credential-values.js";
import type { PreparedGatewayModelCatalogSnapshot } from "../server-model-catalog-auth.js";
import { resolveModelProviderCapabilities } from "./model-provider-capabilities.js";
import { resolveProviderApiKeys } from "./models-auth-status-api-keys.js";
import { resolveConfigBoundProfileIds } from "./models-auth-status-config.js";
import type { ModelAuthStatusProvider } from "./models-auth-status.types.js";

const apiKeyUsageStatusProviders = new Set<UsageProviderId>(["clawrouter", "deepseek"]);

function resolveConfiguredProviders(
  cfg: OpenClawConfig,
  apiKeys: ReadonlyMap<string, ModelAuthStatusProvider["apiKey"]>,
): {
  providers: string[];
  expectsOAuth: Set<string>;
} {
  const out = new Set<string>();
  const expectsOAuth = new Set<string>();
  for (const [id, provider] of Object.entries(cfg.models?.providers ?? {})) {
    const normalized = normalizeProviderId(id);
    if (!normalized) {
      continue;
    }
    const rawKey = typeof provider?.apiKey === "string" ? provider.apiKey.trim() : "";
    const hasApiKey =
      hasConfiguredSecretInput(provider?.apiKey, cfg.secrets?.defaults) &&
      (rawKey === NON_ENV_SECRETREF_MARKER ||
        !isNonSecretApiKeyMarker(rawKey, { includeEnvVarName: false }));
    const mode = provider?.auth;
    if (mode !== "oauth" && mode !== "token" && !hasApiKey) {
      continue;
    }
    if (apiKeys.has(normalized)) {
      continue;
    }
    out.add(normalized);
    if (mode === "oauth") {
      expectsOAuth.add(normalized);
    }
  }
  // auth.profiles opt in via `mode: oauth | token`; API-key profiles have no lifecycle.
  for (const profile of Object.values(cfg.auth?.profiles ?? {})) {
    const provider = profile?.provider;
    const mode = profile?.mode;
    if (
      typeof provider !== "string" ||
      provider.length === 0 ||
      (mode !== "oauth" && mode !== "token")
    ) {
      continue;
    }
    const normalized = normalizeProviderId(provider);
    if (!normalized) {
      continue;
    }
    if (apiKeys.has(normalized)) {
      continue;
    }
    out.add(normalized);
    if (mode === "oauth") {
      expectsOAuth.add(normalized);
    }
  }
  return { providers: Array.from(out), expectsOAuth };
}

type ModelAuthStatusFacts = ReturnType<typeof buildModelAuthStatusFacts>;
const authStatusFacts = new WeakMap<
  OpenClawConfig,
  Map<
    string,
    {
      profiles: AuthProfileStore["profiles"];
      owner: PreparedGatewayModelCatalogSnapshot["isCurrent"];
      metadata: PreparedGatewayModelCatalogSnapshot["metadataSnapshot"];
      agentDir: string;
      workspaceDir: string;
      revision: number;
      facts: ModelAuthStatusFacts;
    }
  >
>();

function buildModelAuthStatusFacts(
  preparedSnapshot: PreparedGatewayModelCatalogSnapshot,
  now: number,
) {
  const { config: cfg, authStore: store, workspaceDir } = preparedSnapshot;
  // Generic auth helpers may consult provider metadata indirectly. Carry this owner's exact
  // snapshot through them so a global miss cannot rediscover plugins on the event loop.
  const authAliasLookupParams = {
    config: cfg,
    workspaceDir,
    metadataSnapshot: preparedSnapshot.metadataSnapshot,
    includeUntrustedWorkspacePlugins: false,
  };
  const apiKeys = resolveProviderApiKeys(cfg, store, authAliasLookupParams);
  const configured = resolveConfiguredProviders(cfg, apiKeys);
  const statusProviderIds = new Set(configured.providers);
  for (const provider of apiKeys.keys()) {
    statusProviderIds.add(provider);
  }
  for (const profile of Object.values(store.profiles)) {
    const provider = normalizeProviderId(profile.provider);
    if (provider) {
      statusProviderIds.add(provider);
    }
  }
  const readAuthHealth = (): AuthHealthSummary =>
    buildAuthHealthSummary({
      store,
      cfg,
      providers: statusProviderIds.size > 0 ? [...statusProviderIds] : undefined,
      allowKeychainPrompt: false,
      authAliasLookupParams,
    });
  const authHealth = readAuthHealth();
  // File-backed bootstrap can change without a Gateway publication. Its reader owns freshness.
  const readsExternalAuth = authHealth.profiles.some(
    (profile) =>
      profile.type === "oauth" &&
      isExternalCliAuthProfileInScope({ store, profileId: profile.profileId }),
  );

  // Usage queries usually need refreshable credentials. Keep API-key status
  // enrichment explicit so static auth providers are not polled by default.
  const usageProviderIds = [
    ...new Set(
      authHealth.profiles
        .filter((p) => {
          if (p.type === "oauth" || p.type === "token") {
            return true;
          }
          const usageProvider = resolveUsageProviderId(p.provider, {
            credentialType: p.type,
          });
          return usageProvider ? apiKeyUsageStatusProviders.has(usageProvider) : false;
        })
        .map((p) => resolveUsageProviderId(p.provider, { credentialType: p.type }))
        .filter((id): id is UsageProviderId => Boolean(id)),
    ),
  ];

  const externalProfileIds = new Set(store.runtimeExternalProfileIds ?? []);
  const externalCliProfileIds = new Set(getRuntimeExternalCliProfileIds(store));
  const logoutProfileIds = new Set(
    Object.entries(store.profiles)
      .filter(
        ([profileId, profile]) =>
          !externalProfileIds.has(profileId) && (profile.type !== "api_key" || !profile.keyRef),
      )
      .map(([profileId]) => profileId),
  );
  const configBoundProfileIds = resolveConfigBoundProfileIds(cfg, store, authAliasLookupParams);
  // Priority mutations cover the whole auth owner, including profiles under aliases.
  // Every alias must advertise that same lock while profile source/logout stays individual.
  const configBoundAuthProviders = new Set(
    Object.entries(store.profiles)
      .filter(([profileId]) => configBoundProfileIds.has(profileId))
      .map(([, profile]) =>
        resolveProviderIdForAuth(profile.provider, {
          ...authAliasLookupParams,
          storedCredential: true,
        }),
      ),
  );
  const providerCapabilities = resolveModelProviderCapabilities({
    config: cfg,
    workspaceDir,
    metadataSnapshot: preparedSnapshot.metadataSnapshot,
  }).capabilities;
  // Credential warning/expiry boundaries are semantic invalidations, not a polling TTL.
  let refreshAt = Infinity;
  for (const profile of authHealth.profiles) {
    if (profile.expiresAt === undefined) {
      continue;
    }
    for (const margin of [DEFAULT_OAUTH_WARN_MS, DEFAULT_OAUTH_REFRESH_MARGIN_MS, 0]) {
      const at = profile.expiresAt - margin;
      if (at > now) {
        refreshAt = Math.min(refreshAt, at);
      }
    }
  }
  return {
    authAliasLookupParams,
    apiKeys,
    configured,
    authHealth,
    readAuthHealth: readsExternalAuth ? readAuthHealth : undefined,
    usageProviderIds,
    externalProfileIds,
    externalCliProfileIds,
    logoutProfileIds,
    configBoundProfileIds,
    configBoundAuthProviders,
    providerCapabilities,
    refreshAt,
  };
}

export function readModelAuthStatusFacts(
  snapshot: PreparedGatewayModelCatalogSnapshot,
  refresh: boolean,
  now: number,
) {
  let agents = authStatusFacts.get(snapshot.config);
  if (!agents) {
    agents = new Map();
    authStatusFacts.set(snapshot.config, agents);
  }
  const revision = getRuntimeAuthProfileStoreSnapshotsRevision();
  const cached = agents.get(snapshot.agentId);
  if (
    !refresh &&
    cached &&
    cached.revision === revision &&
    cached.profiles === snapshot.authStore.profiles &&
    cached.owner === snapshot.isCurrent &&
    cached.metadata === snapshot.metadataSnapshot &&
    cached.agentDir === snapshot.agentDir &&
    cached.workspaceDir === snapshot.workspaceDir &&
    now < cached.facts.refreshAt
  ) {
    return cached.facts.readAuthHealth
      ? { ...cached.facts, authHealth: cached.facts.readAuthHealth() }
      : cached.facts;
  }
  // Preparation is synchronous after acquiring the published owner: concurrent connections
  // reuse this result before another request can begin the same computation.
  const facts = buildModelAuthStatusFacts(snapshot, now);
  agents.set(snapshot.agentId, {
    profiles: snapshot.authStore.profiles,
    owner: snapshot.isCurrent,
    metadata: snapshot.metadataSnapshot,
    agentDir: snapshot.agentDir,
    workspaceDir: snapshot.workspaceDir,
    revision,
    facts,
  });
  return facts;
}
