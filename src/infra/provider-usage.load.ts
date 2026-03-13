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

type UsageSummaryOptions = {
  now?: number;
  timeoutMs?: number;
  providers?: UsageProviderId[];
  auth?: ProviderAuth[];
  agentDir?: string;
  fetch?: typeof fetch;
};

const USAGE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

type UsageCacheEntry = {
  summary?: UsageSummary;
  updatedAt?: number;
  inFlight?: Promise<UsageSummary>;
};

const usageCache: UsageCacheEntry = {};

async function fetchProviderUsageSummary(opts: UsageSummaryOptions = {}): Promise<UsageSummary> {
  const now = opts.now ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = resolveFetch(opts.fetch);
  if (!fetchFn) {
    throw new Error("fetch is not available");
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

  return { updatedAt: now, providers };
}

export async function loadProviderUsageSummary(
  opts: UsageSummaryOptions = {},
): Promise<UsageSummary> {
  // Skip cache when caller overrides auth or fetch (tests, one-off calls).
  const useCache = !opts.auth && !opts.fetch;

  if (useCache) {
    const now = Date.now();
    if (
      usageCache.summary &&
      usageCache.updatedAt &&
      now - usageCache.updatedAt < USAGE_CACHE_TTL_MS
    ) {
      return usageCache.summary;
    }

    if (usageCache.inFlight) {
      if (usageCache.summary) {
        return usageCache.summary;
      }
      return await usageCache.inFlight;
    }
  }

  const inFlight = fetchProviderUsageSummary(opts)
    .then((summary) => {
      if (useCache) {
        usageCache.summary = summary;
        usageCache.updatedAt = Date.now();
      }
      usageCache.inFlight = undefined;
      return summary;
    })
    .catch((err) => {
      usageCache.inFlight = undefined;
      if (useCache && usageCache.summary) {
        return usageCache.summary;
      }
      throw err;
    });

  if (useCache) {
    usageCache.inFlight = inFlight;

    if (usageCache.summary) {
      return usageCache.summary;
    }
  }
  return await inFlight;
}

// Exposed for unit tests.
export const __test = { usageCache, USAGE_CACHE_TTL_MS };
