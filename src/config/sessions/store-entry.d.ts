import type { SessionEntry } from "./types.js";
export declare function normalizeStoreSessionKey(sessionKey: string): string;
export declare function resolveSessionStoreEntry(params: {
    store: Record<string, SessionEntry>;
    sessionKey: string;
}): {
    normalizedKey: string;
    existing: SessionEntry | undefined;
    legacyKeys: string[];
};
