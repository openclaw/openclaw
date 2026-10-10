import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { registerListener } from "../../../../src/shared/listeners.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentIdentityResult } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { isGatewayAvailable, resolveGatewayReadRetryDelayMs } from "../gateway-availability.ts";

type AgentIdentityGatewaySnapshot = Pick<
  ApplicationGatewaySnapshot,
  "client" | "phase" | "restartPending" | "suspensionPhase"
>;

type AgentIdentityGateway = {
  readonly snapshot: AgentIdentityGatewaySnapshot;
  subscribe: (listener: (snapshot: AgentIdentityGatewaySnapshot) => void) => () => void;
  subscribeEvents?: (listener: (event: { event: string }) => void) => () => void;
};

type AgentIdentityCacheEntry = {
  pending: Promise<AgentIdentityResult | null>;
  result?: { identity: AgentIdentityResult | null };
  refreshAt: number;
  failures: number;
};

const AGENT_IDENTITY_CACHE_LIMIT = 128;
const identityRequests = new WeakMap<GatewayBrowserClient, Map<string, AgentIdentityCacheEntry>>();

/** Retire every UI surface's cached request when its connection or roster revision changes. */
function invalidateAgentIdentityCache(
  client: GatewayBrowserClient | null,
  agentIds?: readonly string[],
): void {
  if (!client) {
    return;
  }
  if (agentIds) {
    const cache = identityRequests.get(client);
    for (const agentId of agentIds) {
      cache?.delete(agentId);
    }
  } else {
    identityRequests.delete(client);
  }
}

export function fetchAgentIdentity(
  client: GatewayBrowserClient,
  agentId: string,
): Promise<AgentIdentityResult | null> {
  let cache = identityRequests.get(client);
  if (!cache) {
    cache = new Map();
    identityRequests.set(client, cache);
  }
  const key = agentId.trim();
  const cached = cache.get(key);
  if (cached && Date.now() < cached.refreshAt) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.pending;
  }
  cache.delete(key);
  const entry: AgentIdentityCacheEntry = {
    pending: Promise.resolve(null),
    refreshAt: Infinity,
    failures: cached?.failures ?? 0,
  };
  entry.pending = client
    .request<AgentIdentityResult | null>("agent.identity.get", { agentId: key })
    .then(
      (identity) => {
        if (identityRequests.get(client) !== cache || cache.get(key) !== entry) {
          return null;
        }
        entry.result = { identity };
        return identity;
      },
      (error: unknown) => {
        // Renders share the rejected request until the retry window opens.
        entry.refreshAt = Date.now() + resolveGatewayReadRetryDelayMs(error, entry.failures++);
        throw error;
      },
    )
    .finally(() => {
      for (const [id, candidate] of cache) {
        if (cache.size <= AGENT_IDENTITY_CACHE_LIMIT) {
          break;
        }
        if (candidate.result || Number.isFinite(candidate.refreshAt)) {
          cache.delete(id);
        }
      }
    });
  cache.set(key, entry);
  return entry.pending;
}

export type AgentIdentityCapability = ReturnType<typeof createAgentIdentityCapability>;

export function createAgentIdentityCapability(gateway: AgentIdentityGateway) {
  let cachedClient: GatewayBrowserClient | null = gateway.snapshot.client;
  let cachedConnected = gateway.snapshot.phase === "connected";
  let connectionGeneration = 0;
  const identities = new Map<string, AgentIdentityResult>();
  const invalidationEpochs = new Map<string, number>();
  const listeners = new Set<() => void>();

  const publish = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const resetForGateway = (snapshot: AgentIdentityGatewaySnapshot) => {
    const connected = snapshot.phase === "connected";
    if (snapshot.client === cachedClient && connected === cachedConnected) {
      return;
    }
    const hadIdentities = identities.size > 0;
    invalidateAgentIdentityCache(cachedClient);
    cachedClient = snapshot.client;
    cachedConnected = connected;
    connectionGeneration += 1;
    identities.clear();
    invalidationEpochs.clear();
    if (hadIdentities) {
      publish();
    }
  };

  gateway.subscribe(resetForGateway);

  gateway.subscribeEvents?.((event) => {
    if (event.event !== "config.changed") {
      return;
    }
    invalidateAgentIdentityCache(cachedClient);
    connectionGeneration += 1;
    identities.clear();
    invalidationEpochs.clear();
    publish();
  });

  return {
    get(agentId: string | null | undefined) {
      const normalized = agentId?.trim();
      return normalized ? (identities.get(normalized) ?? null) : null;
    },
    entries() {
      return [...identities.values()];
    },
    async ensure(this: void, agentIds: readonly (string | null | undefined)[]) {
      const snapshot = gateway.snapshot;
      resetForGateway(snapshot);
      const client = snapshot.client;
      if (!client || !isGatewayAvailable(snapshot)) {
        return;
      }
      const generation = connectionGeneration;
      const missing = normalizeUniqueTrimmedStringList(agentIds).filter((agentId) => {
        const cached = identityRequests.get(client)?.get(agentId);
        return !cached?.result || identities.get(agentId) !== cached?.result?.identity;
      });
      if (missing.length === 0) {
        return;
      }
      const results = await Promise.all(
        missing.map(async (agentId) => {
          const invalidationEpoch = invalidationEpochs.get(agentId) ?? 0;
          return [
            agentId,
            invalidationEpoch,
            await fetchAgentIdentity(client, agentId).catch(() => null),
          ] as const;
        }),
      );
      if (
        connectionGeneration !== generation ||
        gateway.snapshot.client !== client ||
        gateway.snapshot.phase !== "connected"
      ) {
        return;
      }
      let changed = false;
      for (const [agentId, invalidationEpoch, identity] of results) {
        // Overlapping ensure calls share the request, so only its first
        // publication changes the snapshot observed by subscribers.
        if (
          identity &&
          identities.get(agentId) !== identity &&
          invalidationEpoch === (invalidationEpochs.get(agentId) ?? 0)
        ) {
          identities.set(agentId, identity);
          changed = true;
        }
      }
      if (changed) {
        publish();
      }
    },
    invalidate(agentIds: readonly (string | null | undefined)[]) {
      let changed = false;
      const ids = normalizeUniqueTrimmedStringList(agentIds);
      invalidateAgentIdentityCache(cachedClient, ids);
      for (const agentId of ids) {
        invalidationEpochs.set(agentId, (invalidationEpochs.get(agentId) ?? 0) + 1);
        if (identities.delete(agentId)) {
          changed = true;
        }
      }
      if (changed) {
        publish();
      }
    },
    subscribe: (listener: () => void) => registerListener(listeners, listener),
  };
}
