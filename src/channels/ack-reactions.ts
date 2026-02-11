export type AckReactionScope = "all" | "direct" | "group-all" | "group-mentions" | "off" | "none";

export type WhatsAppAckReactionMode = "always" | "mentions" | "never";

export type AckReactionGateParams = {
  scope: AckReactionScope | undefined;
  isDirect: boolean;
  isGroup: boolean;
  isMentionableGroup: boolean;
  requireMention: boolean;
  canDetectMention: boolean;
  effectiveWasMentioned: boolean;
  shouldBypassMention?: boolean;
};

export function shouldAckReaction(params: AckReactionGateParams): boolean {
  const scope = params.scope ?? "group-mentions";
  if (scope === "off" || scope === "none") {
    return false;
  }
  if (scope === "all") {
    return true;
  }
  if (scope === "direct") {
    return params.isDirect;
  }
  if (scope === "group-all") {
    return params.isGroup;
  }
  if (scope === "group-mentions") {
    if (!params.isMentionableGroup) {
      return false;
    }
    if (!params.requireMention) {
      return false;
    }
    if (!params.canDetectMention) {
      return false;
    }
    return params.effectiveWasMentioned || params.shouldBypassMention === true;
  }
  return false;
}

export function shouldAckReactionForWhatsApp(params: {
  emoji: string;
  isDirect: boolean;
  isGroup: boolean;
  directEnabled: boolean;
  groupMode: WhatsAppAckReactionMode;
  wasMentioned: boolean;
  groupActivated: boolean;
}): boolean {
  if (!params.emoji) {
    return false;
  }
  if (params.isDirect) {
    return params.directEnabled;
  }
  if (!params.isGroup) {
    return false;
  }
  if (params.groupMode === "never") {
    return false;
  }
  if (params.groupMode === "always") {
    return true;
  }
  return shouldAckReaction({
    scope: "group-mentions",
    isDirect: false,
    isGroup: true,
    isMentionableGroup: true,
    requireMention: true,
    canDetectMention: true,
    effectiveWasMentioned: params.wasMentioned,
    shouldBypassMention: params.groupActivated,
  });
}

// ---------------------------------------------------------------------------
// Enqueued message tracking (for NO_REPLY vs queued distinction)
// ---------------------------------------------------------------------------

const ENQUEUED_MESSAGE_IDS = new Set<string>();

export function markMessageEnqueued(messageId: string): void {
  ENQUEUED_MESSAGE_IDS.add(messageId);
}

export function wasMessageEnqueued(messageId: string): boolean {
  return ENQUEUED_MESSAGE_IDS.has(messageId);
}

export function clearEnqueuedMessage(messageId: string): void {
  ENQUEUED_MESSAGE_IDS.delete(messageId);
}

// ---------------------------------------------------------------------------
// Pending ack-removal registry
// ---------------------------------------------------------------------------
// When a message is enqueued (not immediately replied to), the ack-reaction
// removal callback is stored here keyed by messageTs.  After the followup
// runner finishes processing the batch, `flushPendingAckRemovals` executes
// and cleans them up.
// ---------------------------------------------------------------------------

const PENDING_ACK_REMOVALS = new Map<string, () => void>();

export function registerPendingAckRemoval(messageId: string, remove: () => void): void {
  PENDING_ACK_REMOVALS.set(messageId, remove);
}

export function flushPendingAckRemovals(messageIds: Array<string | undefined>): void {
  for (const id of messageIds) {
    if (!id) {
      continue;
    }
    const remove = PENDING_ACK_REMOVALS.get(id);
    if (remove) {
      remove();
      PENDING_ACK_REMOVALS.delete(id);
    }
  }
}

/** @internal — exposed for testing only */
export function _getPendingAckRemovalsSize(): number {
  return PENDING_ACK_REMOVALS.size;
}

/** @internal — exposed for testing only */
export function _clearPendingAckRemovals(): void {
  PENDING_ACK_REMOVALS.clear();
}

export function removeAckReactionAfterReply(params: {
  removeAfterReply: boolean;
  ackReactionPromise: Promise<boolean> | null;
  ackReactionValue: string | null;
  remove: () => Promise<void>;
  onError?: (err: unknown) => void;
}) {
  if (!params.removeAfterReply) {
    return;
  }
  if (!params.ackReactionPromise) {
    return;
  }
  if (!params.ackReactionValue) {
    return;
  }
  void params.ackReactionPromise.then((didAck) => {
    if (!didAck) {
      return;
    }
    params.remove().catch((err) => params.onError?.(err));
  });
}
