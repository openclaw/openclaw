/**
 * Channel-agnostic helpers for direct-message (1:1) peer bindings.
 *
 * A direct-peer binding targets a single peer rather than a group/topic. Its
 * compiled conversation id is simply the (normalized) peer id, and it has no
 * parent conversation. These helpers are dependency-light and make no
 * assumptions about any particular channel or backend; channels inject their
 * own id normalization via the optional `normalizePeerId` hook.
 */

export type DirectPeerConversationRef = {
  conversationId: string;
  parentConversationId?: undefined;
};

export type DirectPeerConversationMatch = DirectPeerConversationRef & {
  matchPriority: number;
};

/**
 * Optional channel hook to canonicalize/validate a peer id. Returns the
 * canonical id, or null when the id is not a valid direct-peer id for the
 * channel. Defaults to a trim + non-empty check.
 */
export type NormalizePeerId = (id: string) => string | null;

const DEFAULT_MATCH_PRIORITY = 2;

function defaultNormalizePeerId(id: string): string | null {
  const trimmed = id.trim();
  return trimmed ? trimmed : null;
}

/**
 * Returns true when a configured binding explicitly targets a direct (1:1)
 * peer. Accepts the canonical `direct` kind and the legacy `dm` alias
 * (trimmed + lowercased); everything else keeps the channel's default behavior.
 */
export function isDirectPeerBinding(peerKind?: string): boolean {
  const normalized = peerKind?.trim().toLowerCase();
  return normalized === "direct" || normalized === "dm";
}

/**
 * Compiles a direct-peer binding into a conversation ref.
 *
 * The compiled id is the normalized peer id with no parent conversation.
 * Returns null when the id does not normalize to a valid direct-peer id.
 */
export function compileDirectPeerConversation(params: {
  conversationId: string;
  normalizePeerId?: NormalizePeerId;
}): DirectPeerConversationRef | null {
  const normalize = params.normalizePeerId ?? defaultNormalizePeerId;
  const conversationId = normalize(params.conversationId);
  if (!conversationId) {
    return null;
  }
  return {
    conversationId,
    parentConversationId: undefined,
  };
}

/**
 * Matches an inbound conversation against a compiled direct-peer binding.
 *
 * Inbound direct messages have no parent conversation, so any inbound carrying
 * a parent is rejected. Otherwise the inbound matches when its normalized id
 * equals the normalized binding id.
 */
export function matchDirectPeerConversation(params: {
  bindingConversationId: string;
  conversationId: string;
  parentConversationId?: string;
  normalizePeerId?: NormalizePeerId;
  matchPriority?: number;
}): DirectPeerConversationMatch | null {
  const normalize = params.normalizePeerId ?? defaultNormalizePeerId;
  const binding = normalize(params.bindingConversationId);
  if (!binding) {
    return null;
  }
  if (params.parentConversationId?.trim()) {
    return null;
  }
  const incoming = normalize(params.conversationId);
  if (!incoming || incoming !== binding) {
    return null;
  }
  return {
    conversationId: incoming,
    parentConversationId: undefined,
    matchPriority: params.matchPriority ?? DEFAULT_MATCH_PRIORITY,
  };
}
