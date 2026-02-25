import { resolveFetch } from "./fetch.js";
import { type ProviderAuth, resolveProviderAuths } from "./provider-usage.auth.js";
import {
  fetchAntigravityUsage,
  fetchGeminiUsage,
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

export async function loadProviderUsageSummary(
  opts: UsageSummaryOptions = {},
): Promise<UsageSummary> {
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
          case "google-antigravity":
            return await fetchAntigravityUsage(auth.token, timeoutMs, fetchFn);
          case "google-gemini-cli":
            return await fetchGeminiUsage(auth.token, timeoutMs, fetchFn, auth.provider);
          case "xiaomi":
            return {
              provider: "xiaomi",
              displayName: PROVIDER_LABELS.xiaomi,
              windows: [],
            };
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
