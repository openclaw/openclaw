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
    // When the caller knows the peer kind and the binding declares a peer kind,
    // they must match — a direct/* binding must not win for a channel caller,
    // and vice versa. If either side omits the kind, we do not filter on it
    // (preserves backward-compat for peerless cron callers).
    if (resolved.peerKind && normalizedPeerKind && resolved.peerKind !== normalizedPeerKind) {
      continue;
    }
    if (resolved.peerId === "*") {
      if (normalizedPeerId) {
        wildcardPeerMatch ??= resolved.accountId;
      } else {
        // Caller supplied no peer — a wildcard binding has no peer to match against,
        // so treat it as a last-resort peer-ish fallback rather than letting it
        // override channel-only bindings.
        peerlessPeerSpecificFallback ??= resolved.accountId;
      }
    } else if (resolved.peerId) {
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
