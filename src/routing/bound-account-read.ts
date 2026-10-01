import { normalizeChatType, type ChatType } from "../channels/chat-type.js";
import { isRouteBinding, listConfiguredBindings } from "../config/bindings.js";
import type { AgentRouteBinding } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeRouteBindingChannelId,
  normalizeRouteBindingId,
  normalizeRouteBindingRoles,
  resolveNormalizedRouteBindingMatch,
  routeBindingScopeMatches,
} from "./binding-scope.js";
import { peerKindMatches } from "./peer-kind-match.js";
import { normalizeAgentId } from "./session-key.js";

function resolveNormalizedBoundAccountMatch(binding: AgentRouteBinding): {
  agentId: string;
  accountId: string;
  channelId: string;
  peerId?: string;
  peerKind?: ChatType;
  guildId?: string | null;
  teamId?: string | null;
  roles?: string[] | null;
} | null {
  const baseMatch = resolveNormalizedRouteBindingMatch(binding);
  const match = binding.match;
  if (!baseMatch || !match || typeof match !== "object") {
    return null;
  }
  const peerId = match.peer && typeof match.peer.id === "string" ? match.peer.id.trim() : undefined;
  const peerKind = match.peer ? normalizeChatType(match.peer.kind) : undefined;
  return {
    ...baseMatch,
    peerId: peerId || undefined,
    peerKind: peerKind ?? undefined,
    guildId: normalizeRouteBindingId(match.guildId) || null,
    teamId: normalizeRouteBindingId(match.teamId) || null,
    roles: normalizeRouteBindingRoles(match.roles),
  };
}

function buildExactPeerIdSet(params: {
  peerId?: string;
  exactPeerIdAliases?: string[];
}): Set<string> {
  return new Set(
    [params.peerId ?? "", ...(params.exactPeerIdAliases ?? [])]
      .map((peerId) => peerId.trim())
      .filter(Boolean),
  );
}

export function resolveFirstBoundAccountId(params: {
  cfg: OpenClawConfig;
  channelId: string;
  agentId: string;
  peerId?: string;
  exactPeerIdAliases?: string[];
  peerKind?: ChatType;
  groupSpace?: string | null;
  memberRoleIds?: string[];
}): string | undefined {
  const normalizedChannel = normalizeRouteBindingChannelId(params.channelId);
  if (!normalizedChannel) {
    return undefined;
  }
  const normalizedAgentId = normalizeAgentId(params.agentId);
  const exactPeerIds = buildExactPeerIdSet(params);
  const hasPeerContext = exactPeerIds.size > 0;
  const normalizedPeerKind = normalizeChatType(params.peerKind) ?? undefined;
  let memberRoleIds: Set<string> | undefined;
  const scope = {
    groupSpace: params.groupSpace,
    // Keep role preparation behind guild/team checks and share it only within this call.
    get memberRoleIds() {
      return params.memberRoleIds ? (memberRoleIds ??= new Set(params.memberRoleIds)) : undefined;
    },
  };
  let wildcardPeerMatch: string | undefined;
  let channelOnlyFallback: string | undefined;
  for (const binding of listConfiguredBindings(params.cfg)) {
    if (!isRouteBinding(binding)) {
      continue;
    }
    const resolved = resolveNormalizedBoundAccountMatch(binding);
    if (
      !resolved ||
      resolved.channelId !== normalizedChannel ||
      resolved.agentId !== normalizedAgentId
    ) {
      continue;
    }
    if (!routeBindingScopeMatches(resolved, scope)) {
      continue;
    }
    if (!hasPeerContext) {
      // Cron and other peerless callers historically used the first matching
      // agent/channel binding. Keep that fallback order unless the caller has
      // enough peer context for the stricter exact/wildcard routing below.
      return resolved.accountId;
    }
    if (resolved.peerId === "*") {
      // Wildcards require both kinds; otherwise direct/* could select a channel identity.
      if (
        !resolved.peerKind ||
        !normalizedPeerKind ||
        !peerKindMatches(resolved.peerKind, normalizedPeerKind)
      ) {
        continue;
      }
      wildcardPeerMatch ??= resolved.accountId;
    } else if (resolved.peerId) {
      // Exact ids suffice unless both kinds are present and disagree.
      if (
        resolved.peerKind &&
        normalizedPeerKind &&
        !peerKindMatches(resolved.peerKind, normalizedPeerKind)
      ) {
        continue;
      }
      if (exactPeerIds.has(resolved.peerId)) {
        return resolved.accountId;
      }
    } else {
      channelOnlyFallback ??= resolved.accountId;
    }
  }
  return wildcardPeerMatch ?? channelOnlyFallback;
}
