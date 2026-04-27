export type SilentReplyPolicy = "allow" | "disallow";
export type SilentReplyMode = "allow" | "rewrite";
export type SilentReplyConversationType = "direct" | "group" | "internal";
export type SilentReplyPolicyShape = Partial<Record<SilentReplyConversationType, SilentReplyPolicy>>;
export type SilentReplyRewriteShape = Partial<Record<SilentReplyConversationType, boolean>>;
export declare const DEFAULT_SILENT_REPLY_POLICY: Record<SilentReplyConversationType, SilentReplyPolicy>;
export declare const DEFAULT_SILENT_REPLY_REWRITE: Record<SilentReplyConversationType, boolean>;
export declare function classifySilentReplyConversationType(params: {
    sessionKey?: string;
    surface?: string;
    conversationType?: SilentReplyConversationType;
}): SilentReplyConversationType;
export declare function resolveSilentReplyPolicyFromPolicies(params: {
    conversationType: SilentReplyConversationType;
    defaultPolicy?: SilentReplyPolicyShape;
    surfacePolicy?: SilentReplyPolicyShape;
}): SilentReplyPolicy;
export declare function resolveSilentReplyRewriteFromPolicies(params: {
    conversationType: SilentReplyConversationType;
    defaultRewrite?: SilentReplyRewriteShape;
    surfaceRewrite?: SilentReplyRewriteShape;
}): boolean;
export declare function resolveSilentReplyRewriteText(params: {
    seed?: string;
}): string;
