import {
  findNormalizedProviderKey,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  ErrorCodes,
  errorShape,
  validateModelsAuthSetApiKeyParams,
  type ModelsAuthSetApiKeyResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import {
  type AuthProfileHealthStatus,
  type AuthProviderHealth,
  formatRemainingShort,
} from "../../agents/auth-health.js";
import {
  ensureAuthProfileStoreWithoutExternalProfilesAsync,
  externalCliDiscoveryForConfigStatus,
  listProfilesForProvider,
  resolveAuthProfileMetadata,
  resolveExplicitAuthOrderSelection,
} from "../../agents/auth-profiles.js";
import type { RuntimeAuthProfileStore } from "../../agents/auth-profiles/types.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/config.js";
import { providerUsageLabel, resolveUsageProviderId } from "../../infra/provider-usage.shared.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { refreshActiveProviderAuthRuntimeSnapshot } from "../../secrets/runtime.js";
import { abortChatRunsForProvider } from "../chat-abort.js";
import { refreshModelAuthStateAfterMutation } from "../model-auth-refresh.js";
import { hasGatewayAdminScope } from "../operator-scopes.js";
import { loadDeferredCatalog, readPreparedCatalog } from "../server-model-catalog-auth.js";
import { formatForLog } from "../ws-log.js";
import { resolveModelAuthAgentScope } from "./model-auth-agent-scope.js";
import { modelsAuthRefreshHandlers } from "./models-auth-refresh.js";
import { readModelAuthStatusFacts } from "./models-auth-status-facts.js";
import { readProviderUsageStaleWhileRevalidate } from "./models-auth-status-usage-cache.js";
import type {
  ModelAuthExpiry,
  ModelAuthLogoutResult,
  ModelAuthStatusProvider,
  ModelAuthStatusResult,
} from "./models-auth-status.types.js";
import { getProviderUsageRuntimeSnapshot } from "./provider-usage-runtime.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const log = createSubsystemLogger("models-auth-status");
function resolveAuthRefreshScope(cfg: OpenClawConfig): {
  providerIds: string[];
  profileIds?: string[];
} {
  const discovery = externalCliDiscoveryForConfigStatus({ cfg });
  if (discovery.mode !== "scoped") {
    return { providerIds: [] };
  }
  const providerIds = [...(discovery.providerIds ?? [])];
  const profileIds = [...(discovery.profileIds ?? [])];
  return {
    providerIds,
    ...(profileIds.length > 0 ? { profileIds } : {}),
  };
}

function readProviderParam(params: Record<string, unknown>): string | null {
  const raw = params.provider;
  if (typeof raw !== "string") {
    return null;
  }
  const provider = normalizeProviderId(raw);
  return provider || null;
}

type LogoutProfileSelection = { ok: true; profileIds?: string[] } | { ok: false; message: string };

function readLogoutProfileSelection(params: Record<string, unknown>): LogoutProfileSelection {
  if (!("profileIds" in params)) {
    return { ok: true };
  }
  if (!Array.isArray(params.profileIds) || params.profileIds.length === 0) {
    return { ok: false, message: "profileIds must be a non-empty string array" };
  }
  for (const value of params.profileIds) {
    if (typeof value !== "string" || !value.trim()) {
      return { ok: false, message: "profileIds must be a non-empty string array" };
    }
  }
  return { ok: true, profileIds: normalizeUniqueStringEntries(params.profileIds) };
}

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
  return (usageId && providerUsageLabel(usageId)) || provider;
}

type ModelAuthStatusRollup = Pick<AuthProviderHealth, "status" | "expiresAt" | "remainingMs">;

function aggregateProfileStatus(
  profiles: AuthProviderHealth["profiles"],
  now: number,
): ModelAuthStatusRollup {
  const statuses = new Set<AuthProfileHealthStatus>(profiles.map((profile) => profile.status));
  const status = (["expired", "missing", "expiring", "ok", "static"] as const).find((candidate) =>
    statuses.has(candidate),
  );
  const expirable = profiles
    .map((p) => p.expiresAt)
    .filter((v): v is number => asDateTimestampMs(v) !== undefined);
  const expiresAt = expirable.length > 0 ? Math.min(...expirable) : undefined;
  const remainingMs = expiresAt !== undefined ? expiresAt - now : undefined;
  return { status: status ?? "static", expiresAt, remainingMs };
}

/**
 * Aggregate the effective refreshable credential status for the dashboard.
 * OAuth remains authoritative when present; token credentials are the
 * supported fallback after an OAuth-to-token migration. Explicit auth-order
 * exclusions remain authoritative through `effectiveProfiles`.
 *
 * `expectsOAuth` keeps an API-key-only provider `missing` after config switches
 * to OAuth but login has not completed.
 */
export function aggregateRefreshableAuthStatus(
  prov: AuthProviderHealth,
  now: number = Date.now(),
  expectsOAuth = false,
): ModelAuthStatusRollup {
  const profiles = prov.effectiveProfiles ?? prov.profiles;
  for (const type of ["oauth", "token"] as const) {
    const selected = profiles.filter((profile) => profile.type === type);
    if (selected.length > 0) {
      return aggregateProfileStatus(selected, now);
    }
  }
  if (expectsOAuth) {
    return { status: "missing" };
  }
  return { status: prov.status, expiresAt: prov.expiresAt, remainingMs: prov.remainingMs };
}

async function refreshAfterCredentialMutation(
  context: GatewayRequestContext,
  agentId: string,
): Promise<string | undefined> {
  try {
    await refreshModelAuthStateAfterMutation(context.getRuntimeConfig, agentId);
    return undefined;
  } catch (error) {
    log.warn(`credential change saved but auth refresh failed: ${formatForLog(error)}`);
    return "Model auth changes were saved, but the Gateway could not refresh them. Run `openclaw gateway restart` to apply the saved changes.";
  }
}

export const modelsAuthStatusHandlers: GatewayRequestHandlers = {
  ...modelsAuthRefreshHandlers,
  "models.authSetApiKey": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateModelsAuthSetApiKeyParams, "models.authSetApiKey", respond)
    ) {
      return;
    }
    const provider = normalizeProviderId(params.provider);
    await respondUnavailableOnThrow(respond, async () => {
      const config = context.getRuntimeConfig();
      const scope = resolveModelAuthAgentScope(config, params.agentId);
      if (!scope.ok) {
        respond(false, undefined, scope.error);
        return;
      }
      const { saveModelProviderApiKey } = await import("../../commands/models/auth-api-key.js");
      const { profileId, warning: configWarning } = await saveModelProviderApiKey({
        config,
        provider,
        apiKey: params.apiKey,
        agentDir: scope.agentDir,
      });
      const refreshWarning = await refreshAfterCredentialMutation(context, scope.agentId);
      const warning = [configWarning, refreshWarning].filter(Boolean).join(" ");
      const result: ModelsAuthSetApiKeyResult = {
        provider,
        profileId,
        ...(warning ? { warning } : {}),
      };
      respond(true, result, undefined);
    });
  },
  "models.authLogout": async ({ params, respond, context }) => {
    const provider = readProviderParam(params);
    if (!provider) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "provider is required"));
      return;
    }
    const selection = readLogoutProfileSelection(params);
    if (!selection.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selection.message));
      return;
    }
    if (
      (params.credentialType !== undefined && params.credentialType !== "api_key") ||
      (params.credentialType !== undefined && selection.profileIds !== undefined)
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Choose either API keys or specific profiles"),
      );
      return;
    }
    const apiKeyOnly = params.credentialType === "api_key";
    await respondUnavailableOnThrow(respond, async () => {
      const cfg = context.getRuntimeConfig();
      const scope = resolveModelAuthAgentScope(cfg, params.agentId);
      if (!scope.ok) {
        respond(false, undefined, scope.error);
        return;
      }
      const { agentDir } = scope;
      const authProvider = resolveProviderIdForAuth(provider, { config: cfg });
      const store = await ensureAuthProfileStoreWithoutExternalProfilesAsync(agentDir);
      const availableProfiles = listProfilesForProvider(store, provider);
      const removedProfiles =
        selection.profileIds ??
        availableProfiles.filter((profileId) => {
          const credential = store.profiles[profileId];
          return !apiKeyOnly || (credential?.type === "api_key" && !credential.keyRef);
        });
      if (
        selection.profileIds &&
        selection.profileIds.some((profileId) => !availableProfiles.includes(profileId))
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "profileIds contain unavailable auth profiles"),
        );
        return;
      }
      const { removeModelAuthCredentials } = await import("../../commands/models/auth-logout.js");
      const configWarning = await removeModelAuthCredentials({
        cfg,
        agentDir,
        profileIds: removedProfiles,
        ...(apiKeyOnly ? { apiKeyProvider: provider } : {}),
        ...(!apiKeyOnly && !selection.profileIds ? { provider } : {}),
      });
      // A provider-wide abort would terminate runs using credentials this
      // logout preserved (other profiles, tokens, or the config API key). Abort
      // entries do not carry the profile id, so a targeted logout cannot scope
      // the abort and instead leaves in-flight runs to fail on their next
      // request; only a full-provider logout revokes everything and aborts.
      const { runIds: abortedRunIds } =
        selection.profileIds || apiKeyOnly
          ? { runIds: [] as string[] }
          : abortChatRunsForProvider(
              {
                chatAbortControllers: context.chatAbortControllers,
                chatRunState: context.chatRunState,
                removeChatRun: context.removeChatRun,
                agentRunSeq: context.agentRunSeq,
                broadcast: context.broadcast,
                nodeSendToSession: context.nodeSendToSession,
              },
              {
                cfg,
                providerId: authProvider,
                agentId: scope.agentId,
                stopReason: "auth-revoked",
              },
            );
      const refreshWarning = await refreshAfterCredentialMutation(context, scope.agentId);
      const warning = [configWarning, refreshWarning].filter(Boolean).join(" ");
      const result: ModelAuthLogoutResult = {
        provider,
        removedProfiles,
        abortedRunIds,
        ...(warning ? { warning } : {}),
      };
      respond(true, result, undefined);
    });
  },
  "models.authStatus": async ({ params, respond, context, client }) => {
    const now = Date.now();
    const refreshRequested = Boolean(params.refresh);
    const includeProfileIdentity = hasGatewayAdminScope(client);
    const resolveScope = (cfg: OpenClawConfig) =>
      resolveModelAuthAgentScope(
        cfg,
        params.agentId === undefined || params.agentId === ""
          ? tryResolveAmbientOwnerAgentId(cfg)
          : params.agentId,
      );
    await respondUnavailableOnThrow(respond, async () => {
      let cfg = context.getRuntimeConfig();
      let scope = resolveScope(cfg);
      if (!scope.ok) {
        respond(false, undefined, scope.error);
        return;
      }
      if (refreshRequested) {
        // Refresh into the transient prepared owner; mutations alone clear warmed auth state.
        await refreshActiveProviderAuthRuntimeSnapshot();
        cfg = context.getRuntimeConfig();
        scope = resolveScope(cfg);
        if (!scope.ok) {
          respond(false, undefined, scope.error);
          return;
        }
      }
      const preparedSnapshot = refreshRequested
        ? await loadDeferredCatalog(context, scope.agentId, {
            readOnly: true,
            authScope: resolveAuthRefreshScope(cfg),
            refreshAuth: true,
            refreshFullCatalog: false,
          })
        : await readPreparedCatalog(context, scope.agentId);
      if (!preparedSnapshot) {
        // A lifecycle replacement may temporarily withdraw this owner. Status must not
        // rediscover credentials or turn missing preparation into a connection failure.
        const result: ModelAuthStatusResult = {
          ts: now,
          providers: [],
          unavailable: {
            code: "PREPARED_MODEL_AUTH_UNAVAILABLE",
            message:
              "Model authentication status is unavailable. Refresh Models after setup finishes; restart the Gateway if it persists.",
          },
        };
        respond(true, result, undefined);
        return;
      }
      cfg = preparedSnapshot.config;
      const { agentId, agentDir } = preparedSnapshot;
      const store: RuntimeAuthProfileStore = preparedSnapshot.authStore;
      const {
        authAliasLookupParams,
        apiKeys,
        expectsOAuth,
        authHealth,
        usageProviderIds,
        externalProfileIds,
        externalCliProfileIds,
        logoutProfileIds,
        configBoundProfileIds,
        configBoundAuthProviders,
        providerCapabilities,
      } = readModelAuthStatusFacts(preparedSnapshot, refreshRequested, now);

      const providerUsageRuntime = await getProviderUsageRuntimeSnapshot({
        config: cfg,
        agentId,
        agentDir,
        store,
      });
      const usageByProvider = readProviderUsageStaleWhileRevalidate({
        agentId,
        agentDir,
        authStore: providerUsageRuntime.store,
        configRef: cfg,
        credentialKey: providerUsageRuntime.credentialKey,
        forceRefresh: refreshRequested,
        providerIds: usageProviderIds,
        now,
      });

      const providers: ModelAuthStatusProvider[] = [];
      for (const prov of authHealth.providers) {
        const providerKey = normalizeProviderId(prov.provider);
        const authProviderKey = resolveProviderIdForAuth(prov.provider, authAliasLookupParams);
        const profileOrder = resolveExplicitAuthOrderSelection({
          storeOrder: store.order,
          configuredOrder: cfg.auth?.order,
          providerKey,
          providerAuthKey: authProviderKey,
        });
        const storedOrderKey =
          findNormalizedProviderKey(store.order, authProviderKey) ??
          findNormalizedProviderKey(store.order, providerKey);
        const localOrderStored =
          storedOrderKey !== undefined &&
          store.runtimeLocalOrderProviderIds?.includes(storedOrderKey);
        const localProfileIds = new Set(
          store.runtimeLocalProfileIds ??
            Object.keys(store.profiles).filter((profileId) => !externalProfileIds.has(profileId)),
        );
        const providerOrderLocked = configBoundAuthProviders.has(authProviderKey);
        const configuredOrderLocked = profileOrder.order !== undefined && !profileOrder.fromStore;
        const usageProfile =
          prov.profiles.find((profile) => profile.type === "oauth" || profile.type === "token") ??
          prov.profiles.find((profile) => profile.type === "api_key");
        const usageKey = resolveUsageProviderId(prov.provider, {
          credentialType: usageProfile?.type,
        });
        const usage = usageKey ? usageByProvider.get(usageKey) : undefined;
        const rawRollup = aggregateRefreshableAuthStatus(
          prov,
          Date.now(),
          expectsOAuth.has(prov.provider),
        );
        const effectiveProfiles = prov.effectiveProfiles ?? prov.profiles;
        const refreshableProfiles = effectiveProfiles.filter(
          (profile) => profile.type === "oauth" || profile.type === "token",
        );
        // External CLI access tokens rotate without operator action. Keep their raw
        // profile expiry diagnostic, but do not turn it into a provider login warning.
        const externalCliOwnsOAuthRefresh =
          refreshableProfiles.length > 0 &&
          refreshableProfiles.every(
            (profile) => profile.type === "oauth" && externalCliProfileIds.has(profile.profileId),
          );
        const rollup: ModelAuthStatusRollup =
          externalCliOwnsOAuthRefresh &&
          (rawRollup.status === "expired" || rawRollup.status === "expiring")
            ? { status: "ok" }
            : rawRollup;
        const apiKey = apiKeys.get(normalizeProviderId(prov.provider));
        const hasRefreshableProfile = prov.profiles.some(
          (profile) => profile.type === "oauth" || profile.type === "token",
        );
        providers.push({
          provider: prov.provider,
          authProvider: authProviderKey,
          displayName: providerDisplayName(prov.provider),
          status:
            apiKey && !hasRefreshableProfile && rollup.status === "missing"
              ? "static"
              : rollup.status,
          expiry: buildExpiry(rollup.remainingMs, rollup.expiresAt),
          profiles: prov.profiles.map((prof) => {
            const metadata = resolveAuthProfileMetadata({ cfg, store, profileId: prof.profileId });
            const lastUsedAt = store.usageStats?.[prof.profileId]?.lastUsed;
            const profile: ModelAuthStatusProvider["profiles"][number] = {
              profileId: prof.profileId,
              type: prof.type,
              status: prof.status,
              reasonCode: prof.reasonCode,
              source: configBoundProfileIds.has(prof.profileId)
                ? "config"
                : externalProfileIds.has(prof.profileId)
                  ? "external"
                  : localProfileIds.has(prof.profileId)
                    ? "saved"
                    : "inherited",
              expiry: buildExpiry(
                prof.expiresAt === undefined ? prof.remainingMs : prof.expiresAt - Date.now(),
                prof.expiresAt,
              ),
            };
            if (externalCliProfileIds.has(prof.profileId)) {
              profile.externallyManaged = true;
            }
            if (includeProfileIdentity && metadata.displayName) {
              profile.displayName = metadata.displayName;
            }
            if (prof.reasonCode === "setup_inactive") {
              profile.displayName = "Saved sign-in (inactive)";
            }
            if (includeProfileIdentity && metadata.email) {
              profile.email = metadata.email;
            }
            if (includeProfileIdentity && lastUsedAt) {
              profile.lastUsedAt = lastUsedAt;
            }
            if (logoutProfileIds.has(prof.profileId)) {
              profile.logoutSupported = true;
            }
            return profile;
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
                  ...(includeProfileIdentity && usage.accountEmail
                    ? { accountEmail: usage.accountEmail }
                    : {}),
                }
              : undefined,
        });
      }
      const result: ModelAuthStatusResult = { ts: now, providers, providerCapabilities };
      respond(true, result, undefined);
    });
  },
};
