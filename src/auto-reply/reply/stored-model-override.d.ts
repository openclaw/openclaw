import type { SessionEntry } from "../../config/sessions/types.js";
export type StoredModelOverride = {
    provider?: string;
    model: string;
    source: "session" | "parent";
};
export declare function resolveStoredModelOverride(params: {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
    parentSessionKey?: string;
    defaultProvider: string;
}): StoredModelOverride | null;
