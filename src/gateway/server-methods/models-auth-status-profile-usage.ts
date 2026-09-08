import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { AuthHealthSummary } from "../../agents/auth-health.js";
import {
  type AuthProfileStore,
  dedupeProfileIds,
  resolveExplicitAuthOrderSelection,
} from "../../agents/auth-profiles.js";
import {
  isProfileInCooldown,
  resolveProfileUnusableUntil,
} from "../../agents/auth-profiles/usage-state.js";
import type { ProviderAuthAliasLookupParams } from "../../agents/provider-auth-aliases.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSessionAuthProfileOverrideSource } from "../../config/sessions/auth-profile-override-provenance.js";
import { resolveSessionEntryAccessTarget } from "../../config/sessions/session-accessor.js";
import { resolveUsageProviderId } from "../../infra/provider-usage.shared.js";
import { loadProfileUsageStaleWhileRevalidate } from "./models-auth-status-usage-cache.js";
import type { ModelAuthProfileUsage } from "./models-auth-status.types.js";

export type SessionAuthStatusContext = {
  sessionKey: string;
  activeProfileId?: string;
  activeProfileSource?: "auto" | "user" | "user-link";
};

export function resolveSessionAuthStatusContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: unknown;
}): SessionAuthStatusContext | undefined {
  if (typeof params.sessionKey !== "string" || !params.sessionKey.trim()) {
    return undefined;
  }
  const target = resolveSessionEntryAccessTarget({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey.trim(),
  });
  const activeProfileId = target.entry?.authProfileOverride?.trim() || undefined;
  const activeProfileSource = resolveSessionAuthProfileOverrideSource(target.entry);
  return {
    sessionKey: target.canonicalKey,
    ...(activeProfileId ? { activeProfileId } : {}),
    ...(activeProfileSource ? { activeProfileSource } : {}),
  };
}

/** Fetches only effective OAuth profiles, preserving the runtime auth order. */
export async function loadOrderedOAuthProfileUsage(params: {
  authHealth: AuthHealthSummary;
  authAliasLookupParams: ProviderAuthAliasLookupParams;
  cfg: OpenClawConfig;
  store: AuthProfileStore;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  forceRefresh: boolean;
  now: number;
}): Promise<Map<string, ModelAuthProfileUsage>> {
  const usageByProfileId = new Map<string, ModelAuthProfileUsage>();
  const loads: Array<Promise<void>> = [];
  for (const provider of params.authHealth.providers) {
    const providerKey = normalizeProviderId(provider.provider);
    const authProviderKey = resolveProviderIdForAuth(
      provider.provider,
      params.authAliasLookupParams,
    );
    const profileOrder = resolveExplicitAuthOrderSelection({
      storeOrder: params.store.order,
      configuredOrder: params.cfg.auth?.order,
      providerKey,
      providerAuthKey: authProviderKey,
    });
    const effectiveProfiles = provider.effectiveProfiles ?? provider.profiles;
    const effectiveOAuthById = new Map(
      effectiveProfiles
        .filter((profile) => profile.type === "oauth")
        .map((profile) => [profile.profileId, profile]),
    );
    const orderedIds = dedupeProfileIds(
      profileOrder.order ?? effectiveProfiles.map((profile) => profile.profileId),
    );
    const usageProviderId = resolveUsageProviderId(provider.provider, {
      credentialType: "oauth",
    });
    if (!usageProviderId) {
      continue;
    }
    for (const profileId of orderedIds) {
      if (usageByProfileId.has(profileId)) {
        continue;
      }
      const profile = effectiveOAuthById.get(profileId);
      if (!profile) {
        continue;
      }
      if (profile.status === "expired") {
        usageByProfileId.set(profileId, { status: "expired", providerId: usageProviderId });
        continue;
      }
      if (isProfileInCooldown(params.store, profileId, params.now)) {
        const until = resolveProfileUnusableUntil(params.store.usageStats?.[profileId] ?? {});
        usageByProfileId.set(profileId, {
          status: "cooldown",
          providerId: usageProviderId,
          ...(until ? { until } : {}),
        });
        continue;
      }
      if (profile.status === "missing") {
        usageByProfileId.set(profileId, { status: "unavailable", providerId: usageProviderId });
        continue;
      }
      loads.push(
        loadProfileUsageStaleWhileRevalidate({
          agentId: params.agentId,
          agentDir: params.agentDir,
          workspaceDir: params.workspaceDir,
          authStore: params.store,
          configRef: params.cfg,
          profileId,
          providerId: usageProviderId,
          forceRefresh: params.forceRefresh,
          now: params.now,
        }).then((usage) => {
          usageByProfileId.set(profileId, usage);
        }),
      );
    }
  }
  await Promise.all(loads);
  return usageByProfileId;
}
