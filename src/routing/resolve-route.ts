import type { ChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { normalizeChatType } from "../channels/chat-type.js";
import { listBindings } from "./bindings.js";
import {
  buildAgentMainSessionKey,
  buildAgentPeerSessionKey,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
  sanitizeAgentId,
} from "./session-key.js";

/** @deprecated Use ChatType from channels/chat-type.js */
export type RoutePeerKind = ChatType;

export type RoutePeer = {
  kind: ChatType;
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
  /** Discord member role IDs — used for role-based agent routing. */
  memberRoleIds?: string[];
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
    | "binding.guild+roles"
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

function matchesAccountId(match: string | undefined, actual: string): boolean {
  const trimmed = (match ?? "").trim();
  if (!trimmed) {
    return actual === DEFAULT_ACCOUNT_ID;
  }
  if (trimmed === "*") {
    return true;
  }
  return trimmed === actual;
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
    peerKind: peer?.kind ?? "direct",
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

function matchesChannel(
  match: { channel?: string | undefined } | undefined,
  channel: string,
): boolean {
  const key = normalizeToken(match?.channel);
  if (!key) {
    return false;
  }
  return key === channel;
}

function matchesPeer(
  match: { peer?: { kind?: string; id?: string } | undefined } | undefined,
  peer: RoutePeer,
): boolean {
  const m = match?.peer;
  if (!m) {
    return false;
  }
  // Backward compat: normalize "dm" to "direct" in config match rules
  const kind = normalizeChatType(m.kind);
  const id = normalizeId(m.id);
  if (!kind || !id) {
    return false;
  }
  return kind === peer.kind && id === peer.id;
}

function matchesRoles(
  match: { roles?: string[] | undefined } | undefined,
  memberRoleIds: string[],
): boolean {
  const roles = match?.roles;
  if (!Array.isArray(roles) || roles.length === 0) {
    return false;
  }
  return roles.some((role) => memberRoleIds.includes(role));
}

function hasGuildConstraint(match: { guildId?: string | undefined } | undefined): boolean {
  return Boolean(normalizeId(match?.guildId));
}

function hasTeamConstraint(match: { teamId?: string | undefined } | undefined): boolean {
  return Boolean(normalizeId(match?.teamId));
}

function hasRolesConstraint(match: { roles?: string[] | undefined } | undefined): boolean {
  return Array.isArray(match?.roles) && match.roles.length > 0;
}

function matchesOptionalPeer(
  match: { peer?: { kind?: string; id?: string } | undefined } | undefined,
  peer: RoutePeer | null,
): boolean {
  if (!match?.peer) {
    return true;
  }
  if (!peer) {
    return false;
  }
  return matchesPeer(match, peer);
}

function matchesOptionalGuild(
  match: { guildId?: string | undefined } | undefined,
  guildId: string,
): boolean {
  const requiredGuildId = normalizeId(match?.guildId);
  if (!requiredGuildId) {
    return true;
  }
  if (!guildId) {
    return false;
  }
  return requiredGuildId === guildId;
}

function matchesOptionalTeam(
  match: { teamId?: string | undefined } | undefined,
  teamId: string,
): boolean {
  const requiredTeamId = normalizeId(match?.teamId);
  if (!requiredTeamId) {
    return true;
  }
  if (!teamId) {
    return false;
  }
  return requiredTeamId === teamId;
}

function matchesOptionalRoles(
  match: { roles?: string[] | undefined } | undefined,
  memberRoleIds: string[],
): boolean {
  if (!hasRolesConstraint(match)) {
    return true;
  }
  return matchesRoles(match, memberRoleIds);
}

function matchesBindingScope(params: {
  match:
    | {
        peer?: { kind?: string; id?: string } | undefined;
        guildId?: string | undefined;
        teamId?: string | undefined;
        roles?: string[] | undefined;
      }
    | undefined;
  peer: RoutePeer | null;
  guildId: string;
  teamId: string;
  memberRoleIds: string[];
}): boolean {
  return (
    matchesOptionalPeer(params.match, params.peer) &&
    matchesOptionalGuild(params.match, params.guildId) &&
    matchesOptionalTeam(params.match, params.teamId) &&
    matchesOptionalRoles(params.match, params.memberRoleIds)
  );
}

export function resolveAgentRoute(input: ResolveAgentRouteInput): ResolvedAgentRoute {
  const channel = normalizeToken(input.channel);
  const accountId = normalizeAccountId(input.accountId);
  const peer = input.peer ? { kind: input.peer.kind, id: normalizeId(input.peer.id) } : null;
  const guildId = normalizeId(input.guildId);
  const teamId = normalizeId(input.teamId);
  const memberRoleIds = input.memberRoleIds ?? [];

  const bindings = listBindings(input.cfg).filter((binding) => {
    if (!binding || typeof binding !== "object") {
      return false;
    }
    if (!matchesChannel(binding.match, channel)) {
      return false;
    }
    return matchesAccountId(binding.match?.accountId, accountId);
  });

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

  if (peer) {
    const peerMatch = bindings.find(
      (b) =>
        Boolean(b.match?.peer) &&
        matchesBindingScope({
          match: b.match,
          peer,
          guildId,
          teamId,
          memberRoleIds,
        }),
    );
    if (peerMatch) {
      return choose(peerMatch.agentId, "binding.peer");
    }
  }

  // Thread parent inheritance: if peer (thread) didn't match, check parent peer binding
  const parentPeer = input.parentPeer
    ? { kind: input.parentPeer.kind, id: normalizeId(input.parentPeer.id) }
    : null;
  if (parentPeer && parentPeer.id) {
    const parentPeerMatch = bindings.find(
      (b) =>
        Boolean(b.match?.peer) &&
        matchesBindingScope({
          match: b.match,
          peer: parentPeer,
          guildId,
          teamId,
          memberRoleIds,
        }),
    );
    if (parentPeerMatch) {
      return choose(parentPeerMatch.agentId, "binding.peer.parent");
    }
  }

  if (guildId && memberRoleIds.length > 0) {
    const guildRolesMatch = bindings.find(
      (b) =>
        hasGuildConstraint(b.match) &&
        hasRolesConstraint(b.match) &&
        matchesBindingScope({
          match: b.match,
          peer,
          guildId,
          teamId,
          memberRoleIds,
        }),
    );
    if (guildRolesMatch) {
      return choose(guildRolesMatch.agentId, "binding.guild+roles");
    }
  }

  if (guildId) {
    const guildMatch = bindings.find(
      (b) =>
        hasGuildConstraint(b.match) &&
        !hasRolesConstraint(b.match) &&
        matchesBindingScope({
          match: b.match,
          peer,
          guildId,
          teamId,
          memberRoleIds,
        }),
    );
    if (guildMatch) {
      return choose(guildMatch.agentId, "binding.guild");
    }
  }

  if (teamId) {
    const teamMatch = bindings.find(
      (b) =>
        hasTeamConstraint(b.match) &&
        matchesBindingScope({
          match: b.match,
          peer,
          guildId,
          teamId,
          memberRoleIds,
        }),
    );
    if (teamMatch) {
      return choose(teamMatch.agentId, "binding.team");
    }
  }

  const accountMatch = bindings.find(
    (b) =>
      b.match?.accountId?.trim() !== "*" &&
      matchesBindingScope({
        match: b.match,
        peer,
        guildId,
        teamId,
        memberRoleIds,
      }),
  );
  if (accountMatch) {
    return choose(accountMatch.agentId, "binding.account");
  }

  const anyAccountMatch = bindings.find(
    (b) =>
      b.match?.accountId?.trim() === "*" &&
      matchesBindingScope({
        match: b.match,
        peer,
        guildId,
        teamId,
        memberRoleIds,
      }),
  );
  if (anyAccountMatch) {
    return choose(anyAccountMatch.agentId, "binding.channel");
  }

  return choose(resolveDefaultAgentId(input.cfg), "default");
}
