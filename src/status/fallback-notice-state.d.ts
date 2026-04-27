import type { SessionEntry } from "../config/sessions.js";
export type FallbackNoticeState = Pick<SessionEntry, "fallbackNoticeSelectedModel" | "fallbackNoticeActiveModel" | "fallbackNoticeReason">;
export declare function resolveActiveFallbackState(params: {
    selectedModelRef: string;
    activeModelRef: string;
    state?: FallbackNoticeState;
}): {
    active: boolean;
    reason?: string;
};
