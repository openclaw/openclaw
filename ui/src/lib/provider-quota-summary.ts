import type { ModelAuthStatusProvider, ModelAuthStatusResult } from "../api/types.ts";
import { isMonitoredAuthProvider, providerUsageForAccount } from "./model-auth.ts";

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
  providers: string[];
  displayName: string;
  plan?: string;
  accountEmail?: string;
  windows: QuotaLimitSummary[];
  budgets: QuotaBudgetSummary[];
};

export type ProviderQuotaSelection =
  | { status: "known"; group: ProviderQuotaGroup }
  | { status: "unknown" | "unavailable"; group?: never };

/** A provider name identifies a service, never the account serving this session. */
export function resolveProviderQuota(
  providers: readonly ModelAuthStatusProvider[],
  providerId: string | null | undefined,
  authProfileId: string | undefined,
): ProviderQuotaSelection {
  const currentProvider = providerId?.trim().toLowerCase();
  // Session model providers are canonical; usage rows can retain auth aliases.
  const matchingProviders = providers.filter(
    (provider) =>
      isMonitoredAuthProvider(provider) &&
      [provider.provider, provider.usage?.providerId].some(
        (id) => id?.trim().toLowerCase() === currentProvider,
      ) &&
      provider.usage,
  );
  if (!currentProvider || matchingProviders.length === 0) {
    return { status: "unavailable" };
  }
  if (!authProfileId) {
    return { status: "unknown" };
  }
  const candidates = matchingProviders.filter((provider) =>
    providerUsageForAccount(provider, authProfileId),
  );
  const groups = new Map<string, ProviderQuotaGroup>();
  for (const provider of candidates) {
    const usage = provider.usage;
    if (!usage) {
      continue;
    }
    const windows: ProviderQuotaGroup["windows"] = (usage.windows ?? []).map((limit) =>
      Object.assign(
        {
          label: (limit.label || "").trim(),
          usedPercent: Math.max(0, Math.min(100, Math.round(limit.usedPercent))),
        },
        limit.resetAt !== undefined ? { resetAt: limit.resetAt } : {},
      ),
    );
    const budgets: ProviderQuotaGroup["budgets"] = (usage.billing ?? []).flatMap((entry) => {
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
    const identity = JSON.stringify([
      provider.displayName,
      usage.accountEmail ?? null,
      usage.plan ?? null,
      windows,
      budgets,
    ]);
    const existing = groups.get(identity);
    if (existing) {
      continue;
    }
    groups.set(identity, {
      providers: [provider.provider],
      displayName: provider.displayName,
      ...(usage.plan ? { plan: usage.plan } : {}),
      ...(usage.accountEmail ? { accountEmail: usage.accountEmail } : {}),
      windows,
      budgets,
    });
  }
  const available = [...groups.values()];
  if (candidates.length > 0 && available.length === 0) {
    return { status: "unavailable" };
  }
  const group = available.length === 1 ? available[0] : undefined;
  return group ? { status: "known", group } : { status: "unknown" };
}
