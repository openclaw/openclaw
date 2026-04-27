import type { ContextVisibilityMode } from "../config/types.base.js";
export type ContextVisibilityKind = "history" | "thread" | "quote" | "forwarded";
export type ContextVisibilityDecisionReason = "mode_all" | "sender_allowed" | "quote_override" | "blocked";
export type ContextVisibilityDecision = {
    include: boolean;
    reason: ContextVisibilityDecisionReason;
};
export declare function evaluateSupplementalContextVisibility(params: {
    mode: ContextVisibilityMode;
    kind: ContextVisibilityKind;
    senderAllowed: boolean;
}): ContextVisibilityDecision;
export declare function shouldIncludeSupplementalContext(params: {
    mode: ContextVisibilityMode;
    kind: ContextVisibilityKind;
    senderAllowed: boolean;
}): boolean;
export declare function filterSupplementalContextItems<T>(params: {
    items: readonly T[];
    mode: ContextVisibilityMode;
    kind: ContextVisibilityKind;
    isSenderAllowed: (item: T) => boolean;
}): {
    items: T[];
    omitted: number;
};
