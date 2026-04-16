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
  return {
    agentId: normalizeAgentId(binding.agentId),
    accountId: normalizeAccountId(accountId),
    channelId,
    peerId: peerId || undefined,
  };
}

export function resolveFirstBoundAccountId(params: {
  cfg: OpenClawConfig;
  channelId: string;
  agentId: string;
  peerId?: string;
}): string | undefined {
  const normalizedChannel = normalizeBindingChannelId(params.channelId);
  if (!normalizedChannel) {
    return undefined;
  }
  const normalizedAgentId = normalizeAgentId(params.agentId);
  const normalizedPeerId = params.peerId?.trim() || undefined;
  let wildcardPeerMatch: string | undefined;
  let channelOnlyFallback: string | undefined;
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
      wildcardPeerMatch ??= resolved.accountId;
    } else if (resolved.peerId) {
      if (normalizedPeerId && resolved.peerId === normalizedPeerId) {
        return resolved.accountId;
      }
    } else {
      channelOnlyFallback ??= resolved.accountId;
    }
  }
  return wildcardPeerMatch ?? channelOnlyFallback;
}
