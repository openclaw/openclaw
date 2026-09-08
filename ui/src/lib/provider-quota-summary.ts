// Control UI module implements provider quota summary behavior.
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { ModelAuthStatusProvider, ModelAuthStatusResult } from "../api/types.ts";

export function formatQuotaReset(resetAt?: number): string | null {
  const timestampMs = asDateTimestampMs(resetAt);
  if (timestampMs === undefined) {
    return null;
  }
  const diffMs = timestampMs - Date.now();
  if (diffMs <= 0) {
    return "now";
  }
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) {
    return "<1m";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  return new Date(timestampMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Auth-status source props for surfaces that render provider plan usage. */
export type ProviderUsageDisplayProps = {
  basePath?: string;
  modelAuthStatusResult?: ModelAuthStatusResult | null;
};

export type QuotaLimitSummary = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

export type QuotaBudgetSummary = {
  label?: string;
  used: number;
  limit: number;
  unit: string;
};

export type ProviderQuotaGroup = {
  /** Auth provider ids sharing this usage payload (e.g. anthropic + claude-cli). */
  providers: string[];
  displayName: string;
  plan?: string;
  /** Account email the usage was fetched under, when known. */
  accountEmail?: string;
  windows: QuotaLimitSummary[];
  budgets: QuotaBudgetSummary[];
};

export type OAuthProfileQuotaSummary = {
  profileId: string;
  label: string;
  accountEmail?: string;
  plan?: string;
  active: boolean;
  activeSource?: ModelAuthStatusResult["activeProfileSource"];
  status: "ready" | "expired" | "cooldown" | "unavailable";
  until?: number;
  windows: QuotaLimitSummary[];
};

export type OAuthProfileQuotaGroup = {
  providers: string[];
  displayName: string;
  profiles: OAuthProfileQuotaSummary[];
};

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Groups provider usage windows and budget billing into per-provider plan
 * summaries. Rows that share one usage payload (the same subscription exposed
 * through several auth provider ids) collapse into a single group so the
 * popover never repeats identical bars.
 */
export function collectProviderQuotaGroups(
  status: ModelAuthStatusResult | null,
  filter: (provider: ModelAuthStatusProvider) => boolean,
): ProviderQuotaGroup[] {
  const groups: Array<{ identity: string; group: ProviderQuotaGroup }> = [];
  for (const provider of (status?.providers ?? []).filter(filter)) {
    const usage = provider.usage;
    if (!usage) {
      continue;
    }
    const windows: QuotaLimitSummary[] = (usage.windows ?? []).map((limit) => {
      const summary: QuotaLimitSummary = {
        label: (limit.label || "").trim(),
        usedPercent: clampPercent(limit.usedPercent),
      };
      if (limit.resetAt !== undefined) {
        summary.resetAt = limit.resetAt;
      }
      return summary;
    });
    const budgets: QuotaBudgetSummary[] = (usage.billing ?? []).flatMap((entry) => {
      if (
        entry.type !== "budget" ||
        !Number.isFinite(entry.used) ||
        !Number.isFinite(entry.limit) ||
        entry.used < 0 ||
        entry.limit <= 0
      ) {
        return [];
      }
      const budget: QuotaBudgetSummary = {
        used: entry.used,
        limit: entry.limit,
        unit: entry.unit,
      };
      if (entry.label) {
        budget.label = entry.label;
      }
      return [budget];
    });
    if (windows.length === 0 && budgets.length === 0) {
      continue;
    }
    // Session rows report canonical model providers while auth rows may use
    // CLI aliases (claude-cli vs anthropic); expose both ids for matching.
    const providerIds = [
      ...new Set([provider.provider, usage.providerId].filter((id): id is string => Boolean(id))),
    ];
    const identity = JSON.stringify([
      provider.displayName,
      usage.accountEmail ?? null,
      windows,
      budgets,
    ]);
    const existing = groups.find((group) => group.identity === identity);
    if (existing) {
      for (const id of providerIds) {
        if (!existing.group.providers.includes(id)) {
          existing.group.providers.push(id);
        }
      }
      continue;
    }
    groups.push({
      identity,
      group: {
        providers: providerIds,
        displayName: provider.displayName,
        ...(usage.plan ? { plan: usage.plan } : {}),
        ...(usage.accountEmail ? { accountEmail: usage.accountEmail } : {}),
        windows,
        budgets,
      },
    });
  }
  return groups.map((entry) => entry.group);
}

/**
 * Projects only effective OAuth profiles, preserving explicit auth.order and
 * dropping API keys, repeated ids, and inventory rows excluded by that order.
 */
export function collectOAuthProfileQuotaGroups(
  status: ModelAuthStatusResult | null,
  filter: (provider: ModelAuthStatusProvider) => boolean,
): OAuthProfileQuotaGroup[] {
  const groups: OAuthProfileQuotaGroup[] = [];
  for (const provider of (status?.providers ?? []).filter(filter)) {
    const profileById = new Map(provider.profiles.map((profile) => [profile.profileId, profile]));
    const orderedIds =
      provider.profileOrder ?? provider.profiles.map((profile) => profile.profileId);
    const seen = new Set<string>();
    const profiles: OAuthProfileQuotaSummary[] = [];
    const providerIds = new Set<string>([provider.provider]);
    for (const profileId of orderedIds) {
      if (seen.has(profileId)) {
        continue;
      }
      seen.add(profileId);
      const profile = profileById.get(profileId);
      const usage = profile?.usage;
      if (!profile || profile.type !== "oauth" || !usage) {
        continue;
      }
      if (usage.providerId) {
        providerIds.add(usage.providerId);
      }
      const windows = (usage.windows ?? [])
        .filter((window) => window.label === "5h" || window.label === "Week")
        .map((window) => {
          const summary: QuotaLimitSummary = {
            label: window.label,
            usedPercent: clampPercent(window.usedPercent),
          };
          if (window.resetAt !== undefined) {
            summary.resetAt = window.resetAt;
          }
          return summary;
        });
      profiles.push({
        profileId,
        label: profile.displayName?.trim() || profile.email?.trim() || profileId,
        ...(usage.accountEmail || profile.email
          ? { accountEmail: usage.accountEmail ?? profile.email }
          : {}),
        ...(usage.plan ? { plan: usage.plan } : {}),
        active: status?.activeProfileId === profileId,
        ...(status?.activeProfileId === profileId && status.activeProfileSource
          ? { activeSource: status.activeProfileSource }
          : {}),
        status: usage.status,
        ...(usage.until ? { until: usage.until } : {}),
        windows,
      });
    }
    if (profiles.length > 0) {
      groups.push({ providers: [...providerIds], displayName: provider.displayName, profiles });
    }
  }
  return groups;
}
