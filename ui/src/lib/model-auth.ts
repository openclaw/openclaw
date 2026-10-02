import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveUsageProviderId } from "../../../src/infra/provider-usage.shared.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ModelAuthStatusProvider, ModelAuthStatusResult } from "../api/types.ts";
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
  if (p.status === "missing") {
    return true;
  }
  if (!Array.isArray(p.profiles)) {
    return false;
  }
  return p.profiles.some((prof) => prof.type === "oauth" || prof.type === "token");
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

function authStatusRefreshAt(
  result: ModelAuthStatusResult,
  requestedAt: number,
): number | undefined {
  let next: number | undefined;
  // Probe the Gateway's warning windows conservatively: OAuth refresh ownership is private.
  // These are at most three freshness reads per expiry, never local health classifications.
  for (const provider of result.providers) {
    for (const credential of [provider, ...provider.profiles]) {
      if (!credential.expiry) {
        continue;
      }
      for (const margin of [24 * 60 * 60_000, 5 * 60_000, 0]) {
        const at = credential.expiry.at - margin;
        // Map the Gateway clock onto this request's local start, preserving time in transport.
        if (at > result.ts) {
          const localAt = requestedAt + (at - result.ts);
          if (next === undefined || localAt < next) {
            next = localAt;
          }
        }
      }
    }
  }
  return next;
}

export function nextModelAuthStatusRefreshAt(result: ModelAuthStatusResult): number | undefined {
  return authRefreshDeadlines.get(result);
}

export async function loadModelAuthStatus(
  client: GatewayBrowserClient,
  opts: { agentId: string; refresh?: boolean; signal?: AbortSignal },
): Promise<ModelAuthStatusResult> {
  opts.signal?.throwIfAborted();
  const params = {
    ...(opts?.refresh ? { refresh: true } : {}),
    agentId: opts.agentId,
  };
  const request = async (signal?: AbortSignal) => {
    const requestedAt = Date.now();
    const result = signal
      ? await client.request<ModelAuthStatusResult>("models.authStatus", params, { signal })
      : await client.request<ModelAuthStatusResult>("models.authStatus", params);
    const snapshot = result ?? EMPTY_AUTH_STATUS;
    if (Array.isArray(snapshot.providers)) {
      authRefreshDeadlines.set(snapshot, authStatusRefreshAt(snapshot, requestedAt));
    }
    return snapshot;
  };
  let state = authReads.get(client);
  if (!state) {
    state = { entries: new Map(), refreshes: 0 };
    authReads.set(client, state);
  }
  if (opts.refresh) {
    // Explicit refresh can change shared auth without a config event. Keep every
    // refresh independent, and suspend ordinary sharing until all refreshes settle.
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
  // Connection-owned reads survive presenter unmounts until an auth publication invalidates them.
  const requests = state.entries;
  const agentId = opts.agentId;
  let pending = requests.get(agentId);
  if (pending?.refreshAt !== undefined && pending.refreshAt <= Date.now()) {
    requests.delete(agentId);
    pending = undefined;
  }
  if (!pending) {
    const shared: ModelAuthRequest = { promise: request(), subscribers: new Set<object>() };
    requests.set(agentId, shared);
    const finish = () => {
      // A retired read can settle after its replacement; only remove this flight.
      if (requests.get(agentId) === shared) {
        requests.delete(agentId);
      }
    };
    void shared.promise.then((result) => {
      if (result === EMPTY_AUTH_STATUS || result.unavailable || !Array.isArray(result.providers)) {
        finish();
      } else if (requests.get(agentId) === shared) {
        shared.refreshAt = nextModelAuthStatusRefreshAt(result);
      }
    }, finish);
    pending = shared;
  }
  return await subscribeToSharedRequest(pending, {}, opts.signal);
}
