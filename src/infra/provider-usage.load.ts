import { loadConfig } from "../config/config.js";
import { resolveFetch } from "./fetch.js";
import { type ProviderAuth, resolveProviderAuths } from "./provider-usage.auth.js";
import {
  fetchClaudeUsage,
  fetchCodexUsage,
  fetchCopilotUsage,
  fetchGeminiUsage,
  fetchMinimaxUsage,
  fetchZaiUsage,
} from "./provider-usage.fetch.js";
import {
  DEFAULT_TIMEOUT_MS,
  ignoredErrors,
  PROVIDER_LABELS,
  usageProviders,
  withTimeout,
} from "./provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageSummary,
} from "./provider-usage.types.js";

const DEFAULT_CACHE_TTL_MS = 300_000; // 5 min

type CacheEntry = { value: UsageSummary; expiresAt: number };
const usageCache = new Map<string, CacheEntry>();

function cacheKey(opts: UsageSummaryOptions): string {
  // Include sorted providers list to prevent cross-caller key collisions.
  const providers = (opts.providers ?? usageProviders).slice().toSorted().join(",");
  return `${opts.agentDir ?? ""}|${providers}`;
}

function getCached(key: string, now: number, ttlMs: number): UsageSummary | undefined {
  if (ttlMs <= 0) {
    return undefined;
  }
  const entry = usageCache.get(key);
  if (!entry || now >= entry.expiresAt) {
    return undefined;
  }
  return entry.value;
}

function setCached(key: string, value: UsageSummary, now: number, ttlMs: number): void {
  if (ttlMs <= 0) {
    return;
  }
  // Use the same `now` as getCached to keep clocks consistent.
  usageCache.set(key, { value, expiresAt: now + ttlMs });
}

type UsageSummaryOptions = {
  now?: number;
  timeoutMs?: number;
  providers?: UsageProviderId[];
  auth?: ProviderAuth[];
  agentDir?: string;
  fetch?: typeof fetch;
  /** Override config cache TTL (0 = disable). When undefined, uses usage.cacheTtlMs from config. */
  cacheTtlMs?: number;
};

export async function loadProviderUsageSummary(
  opts: UsageSummaryOptions = {},
): Promise<UsageSummary> {
  const now = opts.now ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = resolveFetch(opts.fetch);
  if (!fetchFn) {
    throw new Error("fetch is not available");
  }

  const cfg = loadConfig();
  const ttlMs =
    opts.cacheTtlMs !== undefined
      ? opts.cacheTtlMs
      : (cfg.usage?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);

  // Skip cache when explicit auth is passed (tests/mock scenarios).
  const key = opts.auth ? null : cacheKey(opts);
  if (key !== null) {
    const cached = getCached(key, now, ttlMs);
    if (cached !== undefined) {
      return cached;
    }
  }

  const auths = await resolveProviderAuths({
    providers: opts.providers ?? usageProviders,
    auth: opts.auth,
    agentDir: opts.agentDir,
  });
  if (auths.length === 0) {
    return { updatedAt: now, providers: [] };
  }

  const tasks = auths.map((auth) =>
    withTimeout(
      (async (): Promise<ProviderUsageSnapshot> => {
        switch (auth.provider) {
          case "anthropic":
            return await fetchClaudeUsage(auth.token, timeoutMs, fetchFn);
          case "github-copilot":
            return await fetchCopilotUsage(auth.token, timeoutMs, fetchFn);
          case "google-gemini-cli":
            return await fetchGeminiUsage(auth.token, timeoutMs, fetchFn, auth.provider);
          case "openai-codex":
            return await fetchCodexUsage(auth.token, auth.accountId, timeoutMs, fetchFn);
          case "minimax":
            return await fetchMinimaxUsage(auth.token, timeoutMs, fetchFn);
          case "xiaomi":
            return {
              provider: "xiaomi",
              displayName: PROVIDER_LABELS.xiaomi,
              windows: [],
            };
          case "zai":
            return await fetchZaiUsage(auth.token, timeoutMs, fetchFn);
          default:
            return {
              provider: auth.provider,
              displayName: PROVIDER_LABELS[auth.provider],
              windows: [],
              error: "Unsupported provider",
            };
        }
      })(),
      timeoutMs + 1000,
      {
        provider: auth.provider,
        displayName: PROVIDER_LABELS[auth.provider],
        windows: [],
        error: "Timeout",
      },
    ),
  );

  const snapshots = await Promise.all(tasks);
  const providers = snapshots.filter((entry) => {
    if (entry.windows.length > 0) {
      return true;
    }
    if (!entry.error) {
      return true;
    }
    return !ignoredErrors.has(entry.error);
  });

  const result = { updatedAt: now, providers };
  // Only cache when all included providers returned clean results (no transient errors
  // like 429 or Timeout), so a failed poll cannot poison the cache for the full TTL.
  const hasTransientError = providers.some((p) => p.error);
  if (key !== null && !hasTransientError) {
    setCached(key, result, now, ttlMs);
  }
  return result;
}
