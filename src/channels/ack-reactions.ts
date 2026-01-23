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
  if (scope === "off" || scope === "none") return false;
  if (scope === "all") return true;
  if (scope === "direct") return params.isDirect;
  if (scope === "group-all") return params.isGroup;
  if (scope === "group-mentions") {
    if (!params.isMentionableGroup) return false;
    if (!params.requireMention) return false;
    if (!params.canDetectMention) return false;
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
  if (!params.emoji) return false;
  if (params.isDirect) return params.directEnabled;
  if (!params.isGroup) return false;
  if (params.groupMode === "never") return false;
  if (params.groupMode === "always") return true;
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
