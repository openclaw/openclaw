export type AckReactionScope = "all" | "direct" | "group-all" | "group-mentions" | "off" | "none";

export type WhatsAppAckReactionMode = "always" | "mentions" | "never";

/** Pending ack reaction plus the provider callback needed to remove it after a reply. */
export type AckReactionHandle = {
  ackReactionPromise: Promise<boolean>;
  ackReactionValue: string;
  remove: () => Promise<void>;
};

/** Channel-neutral facts used to decide whether an inbound message gets an ack reaction. */
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

/** Apply channel-neutral ack reaction scope rules before a provider sends an emoji. */
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

/** Adapt WhatsApp's direct/group knobs onto the shared ack reaction gate. */
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

/** Start sending an ack reaction and retain enough state for optional cleanup. */
export function createAckReactionHandle(params: {
  ackReactionValue: string;
  send: () => Promise<void>;
  remove: () => Promise<void>;
  onSendError?: (err: unknown) => void;
}): AckReactionHandle | null {
  const ackReactionValue = params.ackReactionValue.trim();
  if (!ackReactionValue) {
    return null;
  }

  let sendPromise: Promise<void>;
  try {
    sendPromise = params.send();
  } catch (err) {
    sendPromise = Promise.reject(toLintErrorObject(err, "Non-Error rejection"));
  }

  return {
    ackReactionPromise: sendPromise.then(
      () => true,
      (err: unknown) => {
        params.onSendError?.(err);
        return false;
      },
    ),
    ackReactionValue,
    remove: params.remove,
  };
}

/** Remove an ack reaction only after the send path confirmed it was applied. */
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
    params.remove().catch((err: unknown) => params.onError?.(err));
  });
}

/** Convenience wrapper for removing a stored ack reaction handle after reply delivery. */
export function removeAckReactionHandleAfterReply(params: {
  removeAfterReply: boolean;
  ackReaction: AckReactionHandle | null | undefined;
  onError?: (err: unknown) => void;
}) {
  removeAckReactionAfterReply({
    removeAfterReply: params.removeAfterReply,
    ackReactionPromise: params.ackReaction?.ackReactionPromise ?? null,
    ackReactionValue: params.ackReaction?.ackReactionValue ?? null,
    remove: params.ackReaction?.remove ?? (async () => {}),
    onError: params.onError,
  });
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
