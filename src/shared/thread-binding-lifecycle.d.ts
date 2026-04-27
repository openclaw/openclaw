export type ThreadBindingLifecycleRecord = {
    boundAt: number;
    lastActivityAt: number;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
};
export declare function resolveThreadBindingLifecycle(params: {
    record: ThreadBindingLifecycleRecord;
    defaultIdleTimeoutMs: number;
    defaultMaxAgeMs: number;
}): {
    expiresAt?: number;
    reason?: "idle-expired" | "max-age-expired";
};
