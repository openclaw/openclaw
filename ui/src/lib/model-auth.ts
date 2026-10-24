import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveUsageProviderId } from "../../../src/infra/provider-usage.shared.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ModelAuthStatusProvider, ModelAuthStatusResult } from "../api/types.ts";
import { hasOperatorReadAccess } from "../app/operator-access.ts";
import { authReads, type ModelAuthRequest } from "./model-auth-request-state.ts";
import { subscribeToSharedRequest } from "./shared-request-subscription.ts";

const EMPTY_AUTH_STATUS: ModelAuthStatusResult = { ts: 0, providers: [] };
const authRefreshDeadlines = new WeakMap<ModelAuthStatusResult, number | undefined>();
/** Map credential-runtime aliases onto the provider card/attention identity. */
export function canonicalModelAuthProviderId(provider: string): string {
  const normalized = normalizeProviderId(provider);
  return resolveUsageProviderId(normalized) ?? normalized;
}

/** API-key-only providers have no scheduled expiry for the dashboard to monitor. */
export function isMonitoredAuthProvider(p: ModelAuthStatusProvider): boolean {
  return (
    p.status === "missing" ||
    p.profiles.some((prof) => prof.type === "oauth" || prof.type === "token")
  );
}

const AUTH_STATUS_PRIORITY = ["expired", "missing", "expiring", "ok", "static"] as const;

/** Collapse auth aliases before display; Gateway rows retain their auth facts. */
export function listEffectiveModelAuthProviders(
  providers: readonly ModelAuthStatusProvider[],
): ModelAuthStatusProvider[] {
  const groups = new Map<string, ModelAuthStatusProvider[]>();
  for (const provider of providers) {
    const id = canonicalModelAuthProviderId(provider.provider);
    const group = groups.get(id) ?? [];
    group.push(provider);
    groups.set(id, group);
  }
  return [...groups].map(([id, group]) => {
    const selected = group.reduce((worst, candidate) =>
      AUTH_STATUS_PRIORITY.indexOf(candidate.status) < AUTH_STATUS_PRIORITY.indexOf(worst.status)
        ? candidate
        : worst,
    );
    // An API key configured on any alias is a fact of the merged provider, not of
    // the worst-status record alone; dropping it would fake a sign-in gap.
    const apiKey = group.find((provider) => provider.apiKey)?.apiKey;
    return Object.assign({}, selected, {
      provider: id,
      profiles: group.flatMap((provider) => provider.profiles),
      ...(apiKey ? { apiKey } : {}),
    });
  });
}

export function nextModelAuthStatusRefreshAt(result: ModelAuthStatusResult): number | undefined {
  return authRefreshDeadlines.get(result);
}

export async function loadModelAuthStatus(
  client: GatewayBrowserClient,
  opts: { agentId: string; refresh?: boolean; refreshUsage?: boolean; signal?: AbortSignal },
): Promise<ModelAuthStatusResult> {
  opts.signal?.throwIfAborted();
  if (!hasOperatorReadAccess(client.auth)) {
    return EMPTY_AUTH_STATUS;
  }
  const params = {
    ...(opts.refresh ? { refresh: true } : {}),
    ...(opts.refreshUsage ? { refreshUsage: true } : {}),
    agentId: opts.agentId,
  };
  const request = async (signal?: AbortSignal) => {
    const requestedAt = Date.now();
    const result = signal
      ? await client.request<ModelAuthStatusResult>("models.authStatus", params, { signal })
      : await client.request<ModelAuthStatusResult>("models.authStatus", params);
    // RPC result types do not validate payloads; keep malformed auth data out of the cache.
    const snapshot = result ?? EMPTY_AUTH_STATUS;
    if (Array.isArray(snapshot.providers)) {
      let next: number | undefined;
      // Probe the Gateway's warning windows conservatively: OAuth refresh ownership is private.
      // These are at most three freshness reads per expiry, never local health classifications.
      for (const provider of snapshot.providers) {
        for (const credential of [provider, ...provider.profiles]) {
          if (!credential.expiry) {
            continue;
          }
          for (const margin of [24 * 60 * 60_000, 5 * 60_000, 0]) {
            const at = credential.expiry.at - margin;
            // Map the Gateway clock onto this request's local start, preserving time in transport.
            if (at > snapshot.ts) {
              const localAt = requestedAt + (at - snapshot.ts);
              if (next === undefined || localAt < next) {
                next = localAt;
              }
            }
          }
        }
      }
      authRefreshDeadlines.set(snapshot, next);
    }
    return snapshot;
  };
  let state = authReads.get(client);
  if (!state) {
    state = { entries: new Map(), refreshes: 0 };
    authReads.set(client, state);
  }
  if (opts.refresh) {
    // Explicit auth refresh can change every agent's shared credentials.
    state.entries.clear();
    state.refreshes += 1;
    try {
      return await request(opts.signal);
    } finally {
      state.refreshes -= 1;
    }
  }
  if (state.refreshes > 0) {
    return await request(opts.signal);
  }
  // Connection-owned reads survive presenter unmounts, but usage must not live until token expiry.
  const requests = state.entries;
  // Ordinary reads must not wait behind a provider fetch. Share each read mode
  // independently; both consume the Gateway-owned usage freshness deadline.
  const key = JSON.stringify([opts.agentId, Boolean(opts.refreshUsage)]);
  let pending = requests.get(key);
  if (pending?.refreshAt !== undefined && pending.refreshAt <= Date.now()) {
    requests.delete(key);
    pending = undefined;
  }
  if (!pending) {
    const requestedAt = Date.now();
    const shared: ModelAuthRequest = { promise: request(), subscribers: new Set<object>() };
    requests.set(key, shared);
    const finish = () => {
      // A retired read can settle after its replacement; only remove this flight.
      if (requests.get(key) === shared) {
        requests.delete(key);
      }
    };
    void shared.promise.then((result) => {
      if (result === EMPTY_AUTH_STATUS || result.unavailable || !Array.isArray(result.providers)) {
        finish();
      } else if (requests.get(key) === shared) {
        shared.refreshAt = nextModelAuthStatusRefreshAt(result);
        if (result.usageRefreshAt !== undefined) {
          shared.refreshAt = Math.min(
            shared.refreshAt ?? Infinity,
            requestedAt + (result.usageRefreshAt - result.ts),
          );
        }
      }
    }, finish);
    pending = shared;
  }
  return await subscribeToSharedRequest(pending, {}, opts.signal);
}
