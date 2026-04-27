/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
export type MentionGateParams = {
    requireMention: boolean;
    canDetectMention: boolean;
    wasMentioned: boolean;
    implicitMention?: boolean;
    shouldBypassMention?: boolean;
};
/** @deprecated Prefer `InboundMentionDecision`. */
export type MentionGateResult = {
    effectiveWasMentioned: boolean;
    shouldSkip: boolean;
};
/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
export type MentionGateWithBypassParams = {
    isGroup: boolean;
    requireMention: boolean;
    canDetectMention: boolean;
    wasMentioned: boolean;
    implicitMention?: boolean;
    hasAnyMention?: boolean;
    allowTextCommands: boolean;
    hasControlCommand: boolean;
    commandAuthorized: boolean;
};
/** @deprecated Prefer `InboundMentionDecision`. */
export type MentionGateWithBypassResult = MentionGateResult & {
    shouldBypassMention: boolean;
};
export type InboundImplicitMentionKind = "reply_to_bot" | "quoted_bot" | "bot_thread_participant" | "native";
export type InboundMentionFacts = {
    canDetectMention: boolean;
    wasMentioned: boolean;
    hasAnyMention?: boolean;
    implicitMentionKinds?: readonly InboundImplicitMentionKind[];
};
export type InboundMentionPolicy = {
    isGroup: boolean;
    requireMention: boolean;
    allowedImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
    allowTextCommands: boolean;
    hasControlCommand: boolean;
    commandAuthorized: boolean;
};
/** @deprecated Prefer the nested `{ facts, policy }` call shape for new code. */
export type ResolveInboundMentionDecisionFlatParams = InboundMentionFacts & InboundMentionPolicy;
export type ResolveInboundMentionDecisionNestedParams = {
    facts: InboundMentionFacts;
    policy: InboundMentionPolicy;
};
export type ResolveInboundMentionDecisionParams = ResolveInboundMentionDecisionFlatParams | ResolveInboundMentionDecisionNestedParams;
export type InboundMentionDecision = MentionGateResult & {
    implicitMention: boolean;
    matchedImplicitMentionKinds: InboundImplicitMentionKind[];
    shouldBypassMention: boolean;
};
export declare function implicitMentionKindWhen(kind: InboundImplicitMentionKind, enabled: boolean): InboundImplicitMentionKind[];
export declare function resolveInboundMentionDecision(params: ResolveInboundMentionDecisionParams): InboundMentionDecision;
/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
export declare function resolveMentionGating(params: MentionGateParams): MentionGateResult;
/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
export declare function resolveMentionGatingWithBypass(params: MentionGateWithBypassParams): MentionGateWithBypassResult;
