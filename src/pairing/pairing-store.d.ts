import type { ChannelPairingAdapter } from "../channels/plugins/pairing.types.js";
import type { PairingChannel } from "./pairing-store.types.js";
export type { PairingChannel } from "./pairing-store.types.js";
export type PairingRequest = {
    id: string;
    code: string;
    createdAt: string;
    lastSeenAt: string;
    meta?: Record<string, string>;
};
export declare function resolveChannelAllowFromPath(channel: PairingChannel, env?: NodeJS.ProcessEnv, accountId?: string): string;
export declare function readLegacyChannelAllowFromStore(channel: PairingChannel, env?: NodeJS.ProcessEnv): Promise<string[]>;
export declare function readChannelAllowFromStore(channel: PairingChannel, env?: NodeJS.ProcessEnv, accountId?: string): Promise<string[]>;
export declare function readLegacyChannelAllowFromStoreSync(channel: PairingChannel, env?: NodeJS.ProcessEnv): string[];
export declare function readChannelAllowFromStoreSync(channel: PairingChannel, env?: NodeJS.ProcessEnv, accountId?: string): string[];
export declare function clearPairingAllowFromReadCacheForTest(): void;
type AllowFromStoreEntryUpdateParams = {
    channel: PairingChannel;
    entry: string | number;
    accountId?: string;
    env?: NodeJS.ProcessEnv;
};
export declare function addChannelAllowFromStoreEntry(params: AllowFromStoreEntryUpdateParams): Promise<{
    changed: boolean;
    allowFrom: string[];
}>;
export declare function removeChannelAllowFromStoreEntry(params: AllowFromStoreEntryUpdateParams): Promise<{
    changed: boolean;
    allowFrom: string[];
}>;
export declare function listChannelPairingRequests(channel: PairingChannel, env?: NodeJS.ProcessEnv, accountId?: string): Promise<PairingRequest[]>;
export declare function upsertChannelPairingRequest(params: {
    channel: PairingChannel;
    id: string | number;
    accountId: string;
    meta?: Record<string, string | undefined | null>;
    env?: NodeJS.ProcessEnv;
    /** Extension channels can pass their adapter directly to bypass registry lookup. */
    pairingAdapter?: ChannelPairingAdapter;
}): Promise<{
    code: string;
    created: boolean;
}>;
export declare function approveChannelPairingCode(params: {
    channel: PairingChannel;
    code: string;
    accountId?: string;
    env?: NodeJS.ProcessEnv;
}): Promise<{
    id: string;
    entry?: PairingRequest;
} | null>;
