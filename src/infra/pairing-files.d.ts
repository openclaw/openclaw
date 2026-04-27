export { createAsyncLock, readJsonFile, writeJsonAtomic } from "./json-files.js";
export declare function resolvePairingPaths(baseDir: string | undefined, subdir: string): {
    dir: string;
    pendingPath: string;
    pairedPath: string;
};
export declare function pruneExpiredPending<T extends {
    ts: number;
}>(pendingById: Record<string, T>, nowMs: number, ttlMs: number): void;
export type PendingPairingRequestResult<TPending> = {
    status: "pending";
    request: TPending;
    created: boolean;
};
export declare function reconcilePendingPairingRequests<TPending extends {
    requestId: string;
}, TIncoming>(params: {
    pendingById: Record<string, TPending>;
    existing: readonly TPending[];
    incoming: TIncoming;
    canRefreshSingle: (existing: TPending, incoming: TIncoming) => boolean;
    refreshSingle: (existing: TPending, incoming: TIncoming) => TPending;
    buildReplacement: (params: {
        existing: readonly TPending[];
        incoming: TIncoming;
    }) => TPending;
    persist: () => Promise<void>;
}): Promise<PendingPairingRequestResult<TPending>>;
