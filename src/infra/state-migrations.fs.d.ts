import fs from "node:fs";
export type SessionEntryLike = {
    sessionId?: string;
    updatedAt?: number;
} & Record<string, unknown>;
export declare function safeReadDir(dir: string): fs.Dirent[];
export declare function existsDir(dir: string): boolean;
export declare function ensureDir(dir: string): void;
export declare function fileExists(p: string): boolean;
export declare function isLegacyWhatsAppAuthFile(name: string): boolean;
export declare function readSessionStoreJson5(storePath: string): {
    store: Record<string, SessionEntryLike>;
    ok: boolean;
};
