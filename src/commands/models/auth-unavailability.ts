import { buildAuthProfileUnusableHint } from "../../agents/auth-profiles/oauth-refresh-failure.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import {
  isActiveUnusableWindow,
  readAuthProfileUsageStats,
} from "../../agents/auth-profiles/usage-state.js";
import { resolveProfileUnusableUntilForDisplay } from "../../agents/auth-profiles/usage.js";

export function listUnavailableAuthProfiles(store: AuthProfileStore) {
  const now = Date.now();
  return Object.keys(store.usageStats ?? {}).flatMap((profileId) => {
    const until = resolveProfileUnusableUntilForDisplay(store, profileId);
    if (!until || now >= until) {
      return [];
    }
    const stats = readAuthProfileUsageStats(store, profileId);
    const kind: "blocked" | "cooldown" | "disabled" =
      typeof stats?.disabledUntil === "number" && now < stats.disabledUntil
        ? "disabled"
        : isActiveUnusableWindow(stats?.blockedUntil, now)
          ? "blocked"
          : "cooldown";
    const reason =
      kind === "disabled"
        ? stats?.disabledReason
        : kind === "blocked"
          ? stats?.blockedReason
          : stats?.cooldownReason;
    return [
      {
        profileId,
        provider: store.profiles[profileId]?.provider,
        kind,
        reason,
        classification: kind === "cooldown" ? stats?.cooldownClassification : undefined,
        ...(kind === "blocked" && stats?.blockedSource
          ? { blockedSource: stats.blockedSource }
          : {}),
        ...(kind === "blocked" && stats?.blockedScope === "model" && stats.blockedModel
          ? { blockedScope: stats.blockedScope, blockedModel: stats.blockedModel }
          : {}),
        until,
        remainingMs: until - now,
      },
    ];
  });
}

export function summarizeUnavailableAuthProfiles(store: AuthProfileStore) {
  return listUnavailableAuthProfiles(store)
    .map((profile) =>
      Object.assign(
        {
          profileId: profile.profileId,
          provider: profile.provider,
          kind: profile.kind,
          reason: profile.reason,
        },
        profile.classification ? { classification: profile.classification } : {},
        profile.blockedSource ? { blockedSource: profile.blockedSource } : {},
        profile.blockedScope ? { blockedScope: profile.blockedScope } : {},
        profile.blockedModel ? { blockedModel: profile.blockedModel } : {},
        {
          recoveryHint: buildAuthProfileUnusableHint({
            kind: profile.kind,
            reason: profile.reason,
            provider: profile.provider ?? profile.profileId,
            profileId: profile.profileId,
          }),
          until: profile.until,
          remainingMs: profile.remainingMs,
        },
      ),
    )
    .toSorted((a, b) => a.remainingMs - b.remainingMs);
}
