// Public usage fetch helpers for provider plugins.

export type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageWindow,
} from "../infra/provider-usage.types.js";

export {
  fetchClaudeUsage,
  fetchCodexUsage,
  fetchDeepSeekUsage,
  fetchGeminiUsage,
  fetchMinimaxUsage,
  fetchZaiUsage,
} from "../infra/provider-usage.fetch.js";
export { clampPercent, PROVIDER_LABELS } from "../infra/provider-usage.shared.js";
export {
  buildUsageErrorSnapshot,
  buildUsageHttpErrorSnapshot,
  fetchJson,
} from "../infra/provider-usage.fetch.shared.js";

import { loadProviderUsageSummary } from "../infra/provider-usage.load.js";
import { resolveUsageProviderId } from "../infra/provider-usage.shared.js";

// Read-only subscription/limit windows for a provider, shaped for footer/readout
// plugins. A narrow wrapper over loadProviderUsageSummary + resolveUsageProviderId
// so plugins never reach into core infra directly.
export type PluginProviderUsageWindow = {
  label: string;
  used_pct: number;
  pct_left: number;
  resets_in_s?: number;
};
export type PluginProviderUsageLimits = {
  available: boolean;
  source: string;
  display_name?: string;
  windows: PluginProviderUsageWindow[];
};

const LIMITS_TTL_MS = 60_000;
type LimitsCacheEntry = {
  value: PluginProviderUsageLimits | undefined;
  expiresAt: number;
  inFlight?: Promise<PluginProviderUsageLimits | undefined>;
};
const limitsCache = new Map<string, LimitsCacheEntry>();

// Resolve the active provider to a usage-capable id and load its windows. Returns
// undefined when the provider has no core-known usage (e.g. api-key-only or an
// unmapped provider) — callers should treat that as "no limits available" and may
// fall back to their own source. Result is cached per usage-provider for 60s so a
// per-reply footer does not hit the provider's usage endpoint on every message.
export async function getProviderUsageLimits(
  provider: string | undefined | null,
  options?: { credentialType?: string | null; timeoutMs?: number; now?: number },
): Promise<PluginProviderUsageLimits | undefined> {
  const usageId = resolveUsageProviderId(provider, {
    credentialType: options?.credentialType ?? "oauth",
  });
  if (!usageId) {
    return undefined;
  }
  const now = options?.now ?? Date.now();
  const cached = limitsCache.get(usageId);
  if (cached && cached.expiresAt >= now) {
    return cached.inFlight ? await cached.inFlight : cached.value;
  }

  const work = (async (): Promise<PluginProviderUsageLimits | undefined> => {
    try {
      const summary = await loadProviderUsageSummary({
        providers: [usageId],
        timeoutMs: options?.timeoutMs,
        now,
      });
      const snapshot = summary.providers.find((entry) => entry.provider === usageId);
      if (!snapshot || snapshot.error || !snapshot.windows || snapshot.windows.length === 0) {
        return {
          available: false,
          source: "core",
          display_name: snapshot?.displayName,
          windows: [],
        };
      }
      const windows: PluginProviderUsageWindow[] = snapshot.windows.map((entry) => {
        const used = Math.max(0, Math.min(100, entry.usedPercent));
        const resetsInS =
          typeof entry.resetAt === "number" && Number.isFinite(entry.resetAt)
            ? Math.max(0, Math.round((entry.resetAt - now) / 1000))
            : undefined;
        return {
          label: entry.label,
          used_pct: used,
          pct_left: Math.max(0, 100 - used),
          resets_in_s: resetsInS,
        };
      });
      return {
        available: true,
        source: "core",
        display_name: snapshot.displayName,
        windows,
      };
    } catch {
      return undefined;
    }
  })();

  // Preserve the last-known value while refreshing (stale-while-revalidate).
  limitsCache.set(usageId, {
    value: cached?.value,
    expiresAt: now + LIMITS_TTL_MS,
    inFlight: work,
  });
  const value = await work;
  const previous = limitsCache.get(usageId)?.value;
  const resolved = value !== undefined ? value : previous;
  // On a transient failure keep the prior value but retry sooner than the full TTL.
  limitsCache.set(usageId, {
    value: resolved,
    expiresAt: Date.now() + (value !== undefined ? LIMITS_TTL_MS : 15_000),
  });
  return resolved;
}

// Non-blocking accessor for per-reply hot paths (e.g. a reply footer): returns the
// cached value immediately (possibly stale, or undefined on the first call) and
// triggers a background refresh when stale. Never awaits a network fetch, so it
// cannot add latency to reply delivery.
export function getProviderUsageLimitsCached(
  provider: string | undefined | null,
  options?: { credentialType?: string | null; timeoutMs?: number },
): PluginProviderUsageLimits | undefined {
  const usageId = resolveUsageProviderId(provider, {
    credentialType: options?.credentialType ?? "oauth",
  });
  if (!usageId) {
    return undefined;
  }
  const cached = limitsCache.get(usageId);
  const isFresh = Boolean(cached && cached.expiresAt >= Date.now());
  const isRefreshing = Boolean(cached?.inFlight);
  if (!isFresh && !isRefreshing) {
    // Defer to a macrotask: the refresh's synchronous prefix (config/auth
    // resolution) must not run on the caller's hot path (reply delivery).
    const timer = setTimeout(() => {
      void getProviderUsageLimits(provider, options).catch(() => undefined);
    }, 0);
    timer.unref?.();
  }
  return cached?.value;
}
