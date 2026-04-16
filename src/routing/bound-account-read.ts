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

export function resolveFirstBoundAccountId(params: {
  cfg: OpenClawConfig;
  channelId: string;
  agentId: string;
  peerId?: string;
  peerKind?: ChatType;
}): string | undefined {
  const normalizedChannel = normalizeBindingChannelId(params.channelId);
  if (!normalizedChannel) {
    return undefined;
  }
  const normalizedAgentId = normalizeAgentId(params.agentId);
  const normalizedPeerId = params.peerId?.trim() || undefined;
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
      // Wildcard peer bindings are only safe when both sides declare a peer
      // kind AND the kinds agree. If either side lacks a kind, skip — a
      // direct/* binding must never win for a channel caller (or vice versa),
      // and we'd rather fall through to channel-only or the caller account
      // than actively route to the wrong identity.
      if (!resolved.peerKind || !normalizedPeerKind || resolved.peerKind !== normalizedPeerKind) {
        continue;
      }
      if (normalizedPeerId) {
        wildcardPeerMatch ??= resolved.accountId;
      } else {
        peerlessPeerSpecificFallback ??= resolved.accountId;
      }
    } else if (resolved.peerId) {
      // Exact peer id match: peer ids are channel-unique so id alone is
      // sufficient, but when both sides declare a kind they must still agree
      // (avoids a direct-kind binding matching a channel caller that happens
      // to share an id, which can occur on channels where ids are reused
      // across kinds).
      if (resolved.peerKind && normalizedPeerKind && resolved.peerKind !== normalizedPeerKind) {
        continue;
      }
      if (normalizedPeerId && resolved.peerId === normalizedPeerId) {
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
