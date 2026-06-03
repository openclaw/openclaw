// Core-internal resolver for a provider's subscription/usage-limit windows,
// shaped for the reply usage-state contract. Stale-while-revalidate so the
// per-reply snapshot never blocks on a provider usage fetch.
//
// This is intentionally NOT exported through the plugin SDK: the data reaches
// plugins only as the `limits` field on the reply_payload_sending `usageState`,
// which the agent runner attaches when it records the per-turn snapshot. Plugins
// stay pure consumers of the contract and never fetch usage themselves.
import { loadProviderUsageSummary } from "./provider-usage.load.js";
import { resolveUsageProviderId } from "./provider-usage.shared.js";
import type { ReplyUsageLimits, ReplyUsageLimitWindow } from "./provider-usage.types.js";

const LIMITS_TTL_MS = 60_000;
type LimitsCacheEntry = {
  value: ReplyUsageLimits | undefined;
  expiresAt: number;
  inFlight?: Promise<ReplyUsageLimits | undefined>;
};
const limitsCache = new Map<string, LimitsCacheEntry>();

// Resolve the active provider to a usage-capable id and load its windows. Returns
// undefined when the provider has no core-known usage (e.g. api-key-only or an
// unmapped provider). Cached per usage-provider for 60s so a per-reply snapshot
// does not hit the provider's usage endpoint on every message.
export async function getProviderUsageLimits(
  provider: string | undefined | null,
  options?: { credentialType?: string | null; timeoutMs?: number; now?: number },
): Promise<ReplyUsageLimits | undefined> {
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

  const work = (async (): Promise<ReplyUsageLimits | undefined> => {
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
      const windows: ReplyUsageLimitWindow[] = snapshot.windows.map((entry) => {
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

// Non-blocking accessor for the per-reply snapshot path: returns the cached value
// immediately (possibly stale, or undefined on the first call) and triggers a
// background refresh when stale. Never awaits a network fetch, so it cannot add
// latency to reply delivery.
export function getProviderUsageLimitsCached(
  provider: string | undefined | null,
  options?: { credentialType?: string | null; timeoutMs?: number },
): ReplyUsageLimits | undefined {
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

export function clearProviderUsageLimitsCacheForTest(): void {
  limitsCache.clear();
}
