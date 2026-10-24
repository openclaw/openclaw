import type { ModelAuthStatusProvider, ModelAuthStatusResult } from "../api/types.ts";

export type ProviderUsageDisplayProps = {
  basePath?: string;
  modelAuthStatusResult?: ModelAuthStatusResult | null;
};

type QuotaLimitSummary = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

type QuotaBudgetSummary = {
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
  accountEmail?: string;
  windows: QuotaLimitSummary[];
  budgets: QuotaBudgetSummary[];
};

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
  const groups = new Map<string, ProviderQuotaGroup>();
  for (const provider of (status?.providers ?? []).filter(filter)) {
    const usage = provider.usage;
    if (!usage) {
      continue;
    }
    const windows: QuotaLimitSummary[] = (usage.windows ?? []).map((limit) =>
      Object.assign(
        {
          label: (limit.label || "").trim(),
          usedPercent: Math.max(0, Math.min(100, Math.round(limit.usedPercent))),
        },
        limit.resetAt !== undefined ? { resetAt: limit.resetAt } : {},
      ),
    );
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
      return [
        {
          used: entry.used,
          limit: entry.limit,
          unit: entry.unit,
          ...(entry.label ? { label: entry.label } : {}),
        },
      ];
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
    const existing = groups.get(identity);
    if (existing) {
      for (const id of providerIds) {
        if (!existing.providers.includes(id)) {
          existing.providers.push(id);
        }
      }
      continue;
    }
    groups.set(identity, {
      providers: providerIds,
      displayName: provider.displayName,
      ...(usage.plan ? { plan: usage.plan } : {}),
      ...(usage.accountEmail ? { accountEmail: usage.accountEmail } : {}),
      windows,
      budgets,
    });
  }
  return [...groups.values()];
}
