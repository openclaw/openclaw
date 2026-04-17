import { normalizeChatType, type ChatType } from "../channels/chat-type.js";
import { normalizeChatChannelId } from "../channels/ids.js";
import { listRouteBindings } from "../config/bindings.js";
import type { AgentRouteBinding } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeAccountId, normalizeAgentId } from "./session-key.js";

function normalizeBindingChannelId(raw?: string | null): string | null {
  const normalized = normalizeChatChannelId(raw);
  if (normalized) {
    return normalized;
  }
  const fallback = normalizeLowercaseStringOrEmpty(raw);
  return fallback || null;
}

function resolveNormalizedBindingMatch(binding: AgentRouteBinding): {
  agentId: string;
  accountId: string;
  channelId: string;
  peerId?: string;
  peerKind?: ChatType;
} | null {
  if (!binding || typeof binding !== "object") {
    return null;
  }
  const match = binding.match;
  if (!match || typeof match !== "object") {
    return null;
  }
  const channelId = normalizeBindingChannelId(match.channel);
  if (!channelId) {
    return null;
  }
  const accountId = typeof match.accountId === "string" ? match.accountId.trim() : "";
  if (!accountId || accountId === "*") {
    return null;
  }
  const peerId = match.peer && typeof match.peer.id === "string" ? match.peer.id.trim() : undefined;
  const peerKind = match.peer ? normalizeChatType(match.peer.kind) : undefined;
  return {
    agentId: normalizeAgentId(binding.agentId),
    accountId: normalizeAccountId(accountId),
    channelId,
    peerId: peerId || undefined,
    peerKind: peerKind ?? undefined,
  };
}

// Peer-kind equivalence matches resolve-route.ts: `group` and `channel` are
// treated as compatible so bindings authored as `peer.kind: "group"` resolve
// for callers inferred as `"channel"` (Matrix rooms, Slack/Mattermost
// channels) and vice versa.
function peerKindMatches(a: ChatType, b: ChatType): boolean {
  if (a === b) {
    return true;
  }
  return (a === "group" && b === "channel") || (a === "channel" && b === "group");
}

function buildExactPeerIdSet(params: {
  peerId?: string;
  exactPeerIdAliases?: string[];
}): Set<string> {
  const exactPeerIds = new Set<string>();
  const peerId = params.peerId?.trim();
  if (peerId) {
    exactPeerIds.add(peerId);
  }
  for (const alias of params.exactPeerIdAliases ?? []) {
    const trimmed = alias.trim();
    if (trimmed) {
      exactPeerIds.add(trimmed);
    }
  }
  return exactPeerIds;
}

export function resolveFirstBoundAccountId(params: {
  cfg: OpenClawConfig;
  channelId: string;
  agentId: string;
  peerId?: string;
  exactPeerIdAliases?: string[];
  peerKind?: ChatType;
}): string | undefined {
  const normalizedChannel = normalizeBindingChannelId(params.channelId);
  if (!normalizedChannel) {
    return undefined;
  }
  const normalizedAgentId = normalizeAgentId(params.agentId);
  const normalizedPeerId = params.peerId?.trim() || undefined;
  const exactPeerIds = buildExactPeerIdSet({
    peerId: normalizedPeerId,
    exactPeerIdAliases: params.exactPeerIdAliases,
  });
  const normalizedPeerKind = normalizeChatType(params.peerKind) ?? undefined;
  let wildcardPeerMatch: string | undefined;
  let channelOnlyFallback: string | undefined;
  let peerlessPeerSpecificFallback: string | undefined;
  for (const binding of listRouteBindings(params.cfg)) {
    const resolved = resolveNormalizedBindingMatch(binding);
    if (
      !resolved ||
      resolved.channelId !== normalizedChannel ||
      resolved.agentId !== normalizedAgentId
    ) {
      continue;
    }
    if (resolved.peerId === "*") {
      if (!normalizedPeerId) {
        // Peerless caller (for example cron delivery resolution). We have no
        // peer context to apply kind safety against, so accept wildcards as a
        // last-resort fallback — this preserves the pre-existing first-match
        // semantics for configs that only declare wildcard peer bindings.
        peerlessPeerSpecificFallback ??= resolved.accountId;
      } else {
        // Caller has a peer. Wildcard bindings are only safe when both sides
        // declare a peer kind AND the kinds agree — a direct/* binding must
        // never win for a channel caller (or vice versa), and we'd rather fall
        // through to channel-only or the caller account than actively route to
        // the wrong identity.
        if (
          !resolved.peerKind ||
          !normalizedPeerKind ||
          !peerKindMatches(resolved.peerKind, normalizedPeerKind)
        ) {
          continue;
        }
        wildcardPeerMatch ??= resolved.accountId;
      }
    } else if (resolved.peerId) {
      // Exact peer id match: peer ids are channel-unique so id alone is
      // sufficient, but when both sides declare a kind they must still agree
      // (avoids a direct-kind binding matching a channel caller that happens
      // to share an id, which can occur on channels where ids are reused
      // across kinds).
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
      if (!normalizedPeerId) {
        // Preserves the pre-existing "first match wins" semantics for peerless
        // callers (e.g. cron delivery resolution) whose only bindings are
        // peer-specific; otherwise they would silently regress to undefined.
        peerlessPeerSpecificFallback ??= resolved.accountId;
      }
    } else {
      channelOnlyFallback ??= resolved.accountId;
    }
  }
  return wildcardPeerMatch ?? channelOnlyFallback ?? peerlessPeerSpecificFallback;
}
