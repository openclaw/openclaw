export type AckReactionScope = "all" | "direct" | "group-all" | "group-mentions" | "off" | "none";

export type WhatsAppAckReactionMode = "always" | "mentions" | "never";

export function resolveAckReactionChoice(value: string | string[] | undefined): {
  configured: boolean;
  value: string;
} {
  if (value === undefined) {
    return { configured: false, value: "" };
  }
  const candidates = (Array.isArray(value) ? value : [value])
    .map((item) => item.trim())
    .filter(Boolean);
  if (candidates.length === 0) {
    return { configured: true, value: "" };
  }
  const choice = candidates[Math.floor(Math.random() * candidates.length)] ?? "";
  return { configured: true, value: choice };
}

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
