import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentIdentityResult } from "../../api/types.ts";
import type { ApplicationGatewayPhase } from "../../app/gateway.ts";

type AgentIdentityGatewaySnapshot = {
  client: GatewayBrowserClient | null;
  phase: ApplicationGatewayPhase;
};

type AgentIdentityGateway = {
  readonly snapshot: AgentIdentityGatewaySnapshot;
  subscribe: (listener: (snapshot: AgentIdentityGatewaySnapshot) => void) => () => void;
};

// One app-lifetime owner coalesces consumers while retaining the prior
// session-switch freshness window for identities edited outside this tab.
const AGENT_IDENTITY_CACHE_TTL_MS = 60_000;

export type AgentIdentityCapability = {
  get: (agentId: string | null | undefined) => AgentIdentityResult | null;
  entries: () => AgentIdentityResult[];
  ensure: (agentIds: readonly (string | null | undefined)[]) => Promise<void>;
  invalidate: (agentIds: readonly (string | null | undefined)[]) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createAgentIdentityCapability(
  gateway: AgentIdentityGateway,
): AgentIdentityCapability {
  let cachedClient: GatewayBrowserClient | null = gateway.snapshot.client;
  let cachedConnected = gateway.snapshot.phase === "connected";
  let connectionGeneration = 0;
  const identities = new Map<string, AgentIdentityResult>();
  const identityLoadedAt = new Map<string, number>();
  const inFlight = new Map<string, Promise<AgentIdentityResult | null>>();
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
    cachedClient = snapshot.client;
    cachedConnected = connected;
    connectionGeneration += 1;
    identities.clear();
    identityLoadedAt.clear();
    inFlight.clear();
    invalidationEpochs.clear();
    if (hadIdentities) {
      publish();
    }
  };

  gateway.subscribe(resetForGateway);

  const normalizeIds = (agentIds: readonly (string | null | undefined)[]) => [
    ...new Set(
      agentIds
        .map((agentId) => agentId?.trim())
        .filter((agentId): agentId is string => Boolean(agentId)),
    ),
  ];

  const fetchIdentity = (
    client: GatewayBrowserClient,
    agentId: string,
  ): Promise<AgentIdentityResult | null> => {
    const active = inFlight.get(agentId);
    if (active) {
      return active;
    }
    const request = client
      .request<AgentIdentityResult | null>("agent.identity.get", { agentId })
      .catch(() => null)
      .finally(() => {
        if (inFlight.get(agentId) === request) {
          inFlight.delete(agentId);
        }
      });
    inFlight.set(agentId, request);
    return request;
  };

  return {
    get(agentId) {
      const normalized = agentId?.trim();
      return normalized ? (identities.get(normalized) ?? null) : null;
    },
    entries() {
      return [...identities.values()];
    },
    async ensure(agentIds) {
      const snapshot = gateway.snapshot;
      resetForGateway(snapshot);
      const client = snapshot.client;
      if (!client || snapshot.phase !== "connected") {
        return;
      }
      const generation = connectionGeneration;
      const now = Date.now();
      const missing = normalizeIds(agentIds).filter((agentId) => {
        const loadedAt = identityLoadedAt.get(agentId);
        return (
          !identities.has(agentId) ||
          loadedAt === undefined ||
          now - loadedAt >= AGENT_IDENTITY_CACHE_TTL_MS
        );
      });
      if (missing.length === 0) {
        return;
      }
      const results = await Promise.all(
        missing.map(async (agentId) => {
          const invalidationEpoch = invalidationEpochs.get(agentId) ?? 0;
          return [agentId, invalidationEpoch, await fetchIdentity(client, agentId)] as const;
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
        if (identity && invalidationEpoch === (invalidationEpochs.get(agentId) ?? 0)) {
          identities.set(agentId, identity);
          identityLoadedAt.set(agentId, Date.now());
          changed = true;
        }
      }
      if (changed) {
        publish();
      }
    },
    invalidate(agentIds) {
      let changed = false;
      for (const agentId of normalizeIds(agentIds)) {
        invalidationEpochs.set(agentId, (invalidationEpochs.get(agentId) ?? 0) + 1);
        if (identities.delete(agentId)) {
          changed = true;
        }
        identityLoadedAt.delete(agentId);
        inFlight.delete(agentId);
      }
      if (changed) {
        publish();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
