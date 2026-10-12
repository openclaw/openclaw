import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { resolveProfileUnusableUntilForDisplay } from "../../agents/auth-profiles/usage.js";

export function listUnavailableAuthProfiles(store: AuthProfileStore) {
  const now = Date.now();
  return Object.keys(store.usageStats ?? {}).flatMap((profileId) => {
    const until = resolveProfileUnusableUntilForDisplay(store, profileId);
    if (!until || now >= until) {
      return [];
    }
    const stats = store.usageStats?.[profileId];
    const kind: "disabled" | "cooldown" =
      typeof stats?.disabledUntil === "number" && now < stats.disabledUntil
        ? "disabled"
        : "cooldown";
    return [
      {
        profileId,
        provider: store.profiles[profileId]?.provider,
        kind,
        reason: kind === "disabled" ? stats?.disabledReason : stats?.cooldownReason,
        classification: kind === "cooldown" ? stats?.cooldownClassification : undefined,
        until,
        remainingMs: until - now,
      },
    ];
  });
}
