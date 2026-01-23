export type AckReactionScope = "all" | "direct" | "group-all" | "group-mentions" | "off" | "none";

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
