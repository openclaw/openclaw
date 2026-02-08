import type { OpenClawConfig } from "../config/config.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { listBindings } from "./bindings.js";
import {
  buildAgentMainSessionKey,
  buildAgentPeerSessionKey,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
  sanitizeAgentId,
} from "./session-key.js";

// ============================================================================
// ROUTING INDEXES - O(1) lookups instead of O(n) linear scans
// ============================================================================

export type RoutingIndexes = {
  // channel -> peerKey -> agentId
  byChannelAndPeer: Map<string, Map<string, string>>;
  // channel -> guildId -> agentId
  byChannelAndGuild: Map<string, Map<string, string>>;
  // channel -> teamId -> agentId
  byChannelAndTeam: Map<string, Map<string, string>>;
  // channel -> accountId -> agentId (account-only bindings, no peer/guild/team)
  byChannelAndAccount: Map<string, Map<string, string>>;
  // channel -> agentId (wildcard * account bindings)
  byChannelWildcard: Map<string, string>;
};

// Cache for routing indexes - avoids rebuilding on every route resolution
let cachedIndexes: RoutingIndexes | null = null;
let cachedConfigRef: WeakRef<OpenClawConfig> | null = null;

function normalizeBindingChannelId(channel: string | undefined): string {
  return (channel ?? "").trim().toLowerCase();
}

/**
 * Build optimized routing indexes from config bindings.
 * This converts O(n) linear scans to O(1) Map lookups.
 */
export function buildRoutingIndexes(cfg: OpenClawConfig): RoutingIndexes {
  const indexes: RoutingIndexes = {
    byChannelAndPeer: new Map(),
    byChannelAndGuild: new Map(),
    byChannelAndTeam: new Map(),
    byChannelAndAccount: new Map(),
    byChannelWildcard: new Map(),
  };

  for (const binding of listBindings(cfg)) {
    if (!binding || typeof binding !== "object") {
      continue;
    }

    const channel = normalizeBindingChannelId(binding.match?.channel);
    if (!channel) {
      continue;
    }

    const agentId = binding.agentId;
    if (!agentId) {
      continue;
    }

    const accountIdRaw = (binding.match?.accountId ?? "").trim();
    // Normalize accountId: empty means default, "*" means wildcard, otherwise specific
    const accountKey = accountIdRaw === "*" ? "*" : accountIdRaw || DEFAULT_ACCOUNT_ID;

    // Index: peer binding (includes accountId in key to preserve account scoping)
    if (binding.match?.peer?.id && binding.match?.peer?.kind) {
      const peerKind = (binding.match.peer.kind ?? "").trim().toLowerCase();
      const peerId = (binding.match.peer.id ?? "").trim();
      if (peerKind && peerId) {
        // Key format: "accountId:peerKind:peerId" to preserve account matching semantics
        const peerKey = `${accountKey}:${peerKind}:${peerId}`;
        if (!indexes.byChannelAndPeer.has(channel)) {
          indexes.byChannelAndPeer.set(channel, new Map());
        }
        indexes.byChannelAndPeer.get(channel)!.set(peerKey, agentId);
      }
    }

    // Index: guild binding (includes accountId in key)
    if (binding.match?.guildId) {
      const guildId = (binding.match.guildId ?? "").trim();
      if (guildId) {
        const guildKey = `${accountKey}:${guildId}`;
        if (!indexes.byChannelAndGuild.has(channel)) {
          indexes.byChannelAndGuild.set(channel, new Map());
        }
        indexes.byChannelAndGuild.get(channel)!.set(guildKey, agentId);
      }
    }

    // Index: team binding (includes accountId in key)
    if (binding.match?.teamId) {
      const teamId = (binding.match.teamId ?? "").trim();
      if (teamId) {
        const teamKey = `${accountKey}:${teamId}`;
        if (!indexes.byChannelAndTeam.has(channel)) {
          indexes.byChannelAndTeam.set(channel, new Map());
        }
        indexes.byChannelAndTeam.get(channel)!.set(teamKey, agentId);
      }
    }

    // Index: account binding (no peer/guild/team)
    const hasPeer = binding.match?.peer?.id;
    const hasGuild = binding.match?.guildId;
    const hasTeam = binding.match?.teamId;
    if (!hasPeer && !hasGuild && !hasTeam) {
      if (accountIdRaw === "*") {
        indexes.byChannelWildcard.set(channel, agentId);
      } else {
        // Account-specific binding (includes empty accountId which means "default account only")
        if (!indexes.byChannelAndAccount.has(channel)) {
          indexes.byChannelAndAccount.set(channel, new Map());
        }
        indexes.byChannelAndAccount.get(channel)!.set(accountKey, agentId);
      }
    }
  }

  return indexes;
}

/**
 * Get or build routing indexes for the given config.
 * Uses a cache to avoid rebuilding indexes on every call.
 */
function getRoutingIndexes(cfg: OpenClawConfig): RoutingIndexes {
  // Check if we have cached indexes for this config
  if (cachedIndexes && cachedConfigRef) {
    const cachedConfig = cachedConfigRef.deref();
    if (cachedConfig === cfg) {
      return cachedIndexes;
    }
  }

  // Build new indexes and cache them
  cachedIndexes = buildRoutingIndexes(cfg);
  cachedConfigRef = new WeakRef(cfg);
  return cachedIndexes;
}

/**
 * Clear the routing index cache (useful for testing or config reload).
 */
export function clearRoutingIndexCache(): void {
  cachedIndexes = null;
  cachedConfigRef = null;
}

export type RoutePeerKind = "dm" | "group" | "channel";

export type RoutePeer = {
  kind: RoutePeerKind;
  id: string;
};

export type ResolveAgentRouteInput = {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string | null;
  peer?: RoutePeer | null;
  /** Parent peer for threads — used for binding inheritance when peer doesn't match directly. */
  parentPeer?: RoutePeer | null;
  guildId?: string | null;
  teamId?: string | null;
};

export type ResolvedAgentRoute = {
  agentId: string;
  channel: string;
  accountId: string;
  /** Internal session key used for persistence + concurrency. */
  sessionKey: string;
  /** Convenience alias for direct-chat collapse. */
  mainSessionKey: string;
  /** Match description for debugging/logging. */
  matchedBy:
    | "binding.peer"
    | "binding.peer.parent"
    | "binding.guild"
    | "binding.team"
    | "binding.account"
    | "binding.channel"
    | "default";
};

export { DEFAULT_ACCOUNT_ID, DEFAULT_AGENT_ID } from "./session-key.js";

function normalizeToken(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeId(value: string | undefined | null): string {
  return (value ?? "").trim();
}

function normalizeAccountId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : DEFAULT_ACCOUNT_ID;
}

export function buildAgentSessionKey(params: {
  agentId: string;
  channel: string;
  accountId?: string | null;
  peer?: RoutePeer | null;
  /** DM session scope. */
  dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  identityLinks?: Record<string, string[]>;
}): string {
  const channel = normalizeToken(params.channel) || "unknown";
  const peer = params.peer;
  return buildAgentPeerSessionKey({
    agentId: params.agentId,
    mainKey: DEFAULT_MAIN_KEY,
    channel,
    accountId: params.accountId,
    peerKind: peer?.kind ?? "dm",
    peerId: peer ? normalizeId(peer.id) || "unknown" : null,
    dmScope: params.dmScope,
    identityLinks: params.identityLinks,
  });
}

function listAgents(cfg: OpenClawConfig) {
  const agents = cfg.agents?.list;
  return Array.isArray(agents) ? agents : [];
}

function pickFirstExistingAgentId(cfg: OpenClawConfig, agentId: string): string {
  const trimmed = (agentId ?? "").trim();
  if (!trimmed) {
    return sanitizeAgentId(resolveDefaultAgentId(cfg));
  }
  const normalized = normalizeAgentId(trimmed);
  const agents = listAgents(cfg);
  if (agents.length === 0) {
    return sanitizeAgentId(trimmed);
  }
  const match = agents.find((agent) => normalizeAgentId(agent.id) === normalized);
  if (match?.id?.trim()) {
    return sanitizeAgentId(match.id.trim());
  }
  return sanitizeAgentId(resolveDefaultAgentId(cfg));
}

export function resolveAgentRoute(input: ResolveAgentRouteInput): ResolvedAgentRoute {
  const channel = normalizeToken(input.channel);
  const accountId = normalizeAccountId(input.accountId);
  const peer = input.peer ? { kind: input.peer.kind, id: normalizeId(input.peer.id) } : null;
  const guildId = normalizeId(input.guildId);
  const teamId = normalizeId(input.teamId);

  const dmScope = input.cfg.session?.dmScope ?? "main";
  const identityLinks = input.cfg.session?.identityLinks;

  const choose = (agentId: string, matchedBy: ResolvedAgentRoute["matchedBy"]) => {
    const resolvedAgentId = pickFirstExistingAgentId(input.cfg, agentId);
    const sessionKey = buildAgentSessionKey({
      agentId: resolvedAgentId,
      channel,
      accountId,
      peer,
      dmScope,
      identityLinks,
    }).toLowerCase();
    const mainSessionKey = buildAgentMainSessionKey({
      agentId: resolvedAgentId,
      mainKey: DEFAULT_MAIN_KEY,
    }).toLowerCase();
    return {
      agentId: resolvedAgentId,
      channel,
      accountId,
      sessionKey,
      mainSessionKey,
      matchedBy,
    };
  };

  // Use optimized O(1) index lookups instead of O(n) linear scans
  const indexes = getRoutingIndexes(input.cfg);

  // Helper to lookup with account scoping: first try specific accountId, then wildcard "*"
  const lookupWithAccountFallback = (
    map: Map<string, string> | undefined,
    baseKey: string,
  ): string | undefined => {
    if (!map) {
      return undefined;
    }
    // Try specific account first
    const specific = map.get(`${accountId}:${baseKey}`);
    if (specific) {
      return specific;
    }
    // Fallback to wildcard account
    return map.get(`*:${baseKey}`);
  };

  // 1. Peer binding (O(1) lookup with account scoping)
  if (peer) {
    const peerBaseKey = `${peer.kind}:${peer.id}`;
    const peerByChannel = indexes.byChannelAndPeer.get(channel);
    const peerAgentId = lookupWithAccountFallback(peerByChannel, peerBaseKey);
    if (peerAgentId) {
      return choose(peerAgentId, "binding.peer");
    }
  }

  // 2. Parent peer binding for thread inheritance (O(1) lookup with account scoping)
  const parentPeer = input.parentPeer
    ? { kind: input.parentPeer.kind, id: normalizeId(input.parentPeer.id) }
    : null;
  if (parentPeer && parentPeer.id) {
    const parentPeerBaseKey = `${parentPeer.kind}:${parentPeer.id}`;
    const peerByChannel = indexes.byChannelAndPeer.get(channel);
    const parentPeerAgentId = lookupWithAccountFallback(peerByChannel, parentPeerBaseKey);
    if (parentPeerAgentId) {
      return choose(parentPeerAgentId, "binding.peer.parent");
    }
  }

  // 3. Guild binding (O(1) lookup with account scoping)
  if (guildId) {
    const guildByChannel = indexes.byChannelAndGuild.get(channel);
    const guildAgentId = lookupWithAccountFallback(guildByChannel, guildId);
    if (guildAgentId) {
      return choose(guildAgentId, "binding.guild");
    }
  }

  // 4. Team binding (O(1) lookup with account scoping)
  if (teamId) {
    const teamByChannel = indexes.byChannelAndTeam.get(channel);
    const teamAgentId = lookupWithAccountFallback(teamByChannel, teamId);
    if (teamAgentId) {
      return choose(teamAgentId, "binding.team");
    }
  }

  // 5. Account binding (O(1) lookup)
  const accountByChannel = indexes.byChannelAndAccount.get(channel);
  const accountAgentId = accountByChannel?.get(accountId);
  if (accountAgentId) {
    return choose(accountAgentId, "binding.account");
  }

  // 6. Wildcard channel binding (O(1) lookup)
  const wildcardAgentId = indexes.byChannelWildcard.get(channel);
  if (wildcardAgentId) {
    return choose(wildcardAgentId, "binding.channel");
  }

  // 7. Default fallback
  return choose(resolveDefaultAgentId(input.cfg), "default");
}
