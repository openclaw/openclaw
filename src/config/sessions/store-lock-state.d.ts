export type SessionStoreLockTask = {
    fn: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timeoutMs?: number;
    staleMs: number;
};
export type SessionStoreLockQueue = {
    running: boolean;
    pending: SessionStoreLockTask[];
    drainPromise: Promise<void> | null;
};
export declare const LOCK_QUEUES: Map<string, SessionStoreLockQueue>;
export declare function clearSessionStoreCacheForTest(): void;
export declare function drainSessionStoreLockQueuesForTest(): Promise<void>;
export declare function getSessionStoreLockQueueSizeForTest(): number;
