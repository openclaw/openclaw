import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type QueuedDelivery, type QueuedDeliveryPayload } from "./delivery-queue-storage.js";
export type RecoverySummary = {
    recovered: number;
    failed: number;
    skippedMaxRetries: number;
    deferredBackoff: number;
};
export type DeliverFn = (params: {
    cfg: OpenClawConfig;
} & QueuedDeliveryPayload & {
    skipQueue?: boolean;
}) => Promise<unknown>;
export interface RecoveryLogger {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
}
export interface PendingDeliveryDrainDecision {
    match: boolean;
    bypassBackoff?: boolean;
}
export type ActiveDeliveryClaimResult<T> = {
    status: "claimed";
    value: T;
} | {
    status: "claimed-by-other-owner";
};
declare const MAX_RETRIES = 5;
export declare function withActiveDeliveryClaim<T>(entryId: string, fn: () => Promise<T>): Promise<ActiveDeliveryClaimResult<T>>;
/** Compute the backoff delay in ms for a given retry count. */
export declare function computeBackoffMs(retryCount: number): number;
export declare function isEntryEligibleForRecoveryRetry(entry: QueuedDelivery, now: number): {
    eligible: true;
} | {
    eligible: false;
    remainingBackoffMs: number;
};
export declare function isPermanentDeliveryError(error: string): boolean;
export declare function drainPendingDeliveries(opts: {
    drainKey: string;
    logLabel: string;
    cfg: OpenClawConfig;
    log: RecoveryLogger;
    stateDir?: string;
    deliver: DeliverFn;
    selectEntry: (entry: QueuedDelivery, now: number) => PendingDeliveryDrainDecision;
}): Promise<void>;
/**
 * On gateway startup, scan the delivery queue and retry any pending entries.
 * Uses exponential backoff and moves entries that exceed MAX_RETRIES to failed/.
 */
export declare function recoverPendingDeliveries(opts: {
    deliver: DeliverFn;
    log: RecoveryLogger;
    cfg: OpenClawConfig;
    stateDir?: string;
    /** Maximum wall-clock time for recovery in ms. Remaining entries are deferred to next startup. Default: 60 000. */
    maxRecoveryMs?: number;
}): Promise<RecoverySummary>;
export { MAX_RETRIES };
