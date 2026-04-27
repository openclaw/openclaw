import { acquireSessionWriteLock } from "../../agents/session-write-lock.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { type SessionDiskBudgetSweepResult } from "./disk-budget.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import { capEntryCount, getActiveSessionMaintenanceWarning, pruneStaleEntries, rotateSessionFile, type ResolvedSessionMaintenanceConfig, type SessionMaintenanceWarning } from "./store-maintenance.js";
import { type SessionEntry } from "./types.js";
export { clearSessionStoreCacheForTest, drainSessionStoreLockQueuesForTest, getSessionStoreLockQueueSizeForTest, } from "./store-lock-state.js";
export { loadSessionStore } from "./store-load.js";
export { normalizeStoreSessionKey, resolveSessionStoreEntry } from "./store-entry.js";
export declare function setSessionWriteLockAcquirerForTests(acquirer: typeof acquireSessionWriteLock | null): void;
export declare function resetSessionStoreLockRuntimeForTests(): void;
export declare function withSessionStoreLockForTest<T>(storePath: string, fn: () => Promise<T>, opts?: SessionStoreLockOptions): Promise<T>;
export declare function readSessionUpdatedAt(params: {
    storePath: string;
    sessionKey: string;
}): number | undefined;
export type SessionMaintenanceApplyReport = {
    mode: ResolvedSessionMaintenanceConfig["mode"];
    beforeCount: number;
    afterCount: number;
    pruned: number;
    capped: number;
    diskBudget: SessionDiskBudgetSweepResult | null;
};
export { capEntryCount, getActiveSessionMaintenanceWarning, pruneStaleEntries, resolveMaintenanceConfig, rotateSessionFile, };
export type { ResolvedSessionMaintenanceConfig, SessionMaintenanceWarning };
type SaveSessionStoreOptions = {
    /** Skip pruning, capping, and rotation (e.g. during one-time migrations). */
    skipMaintenance?: boolean;
    /** Active session key for warn-only maintenance. */
    activeSessionKey?: string;
    /**
     * Session keys that are allowed to drop persisted ACP metadata during this update.
     * All other updates preserve existing `entry.acp` blocks when callers replace the
     * whole session entry without carrying ACP state forward.
     */
    allowDropAcpMetaSessionKeys?: string[];
    /** Optional callback for warn-only maintenance. */
    onWarn?: (warning: SessionMaintenanceWarning) => void | Promise<void>;
    /** Optional callback with maintenance stats after a save. */
    onMaintenanceApplied?: (report: SessionMaintenanceApplyReport) => void | Promise<void>;
    /** Optional overrides used by maintenance commands. */
    maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
    /** Fully resolved maintenance settings when the caller already has config loaded. */
    maintenanceConfig?: ResolvedSessionMaintenanceConfig;
};
export declare function saveSessionStore(storePath: string, store: Record<string, SessionEntry>, opts?: SaveSessionStoreOptions): Promise<void>;
export declare function updateSessionStore<T>(storePath: string, mutator: (store: Record<string, SessionEntry>) => Promise<T> | T, opts?: SaveSessionStoreOptions): Promise<T>;
type SessionStoreLockOptions = {
    timeoutMs?: number;
    pollIntervalMs?: number;
    staleMs?: number;
};
export declare function archiveRemovedSessionTranscripts(params: {
    removedSessionFiles: Iterable<[string, string | undefined]>;
    referencedSessionIds: ReadonlySet<string>;
    storePath: string;
    reason: "deleted" | "reset";
    restrictToStoreDir?: boolean;
}): Promise<Set<string>>;
export declare function updateSessionStoreEntry(params: {
    storePath: string;
    sessionKey: string;
    update: (entry: SessionEntry) => Promise<Partial<SessionEntry> | null>;
}): Promise<SessionEntry | null>;
export declare function recordSessionMetaFromInbound(params: {
    storePath: string;
    sessionKey: string;
    ctx: MsgContext;
    groupResolution?: import("./types.js").GroupKeyResolution | null;
    createIfMissing?: boolean;
}): Promise<SessionEntry | null>;
export declare function updateLastRoute(params: {
    storePath: string;
    sessionKey: string;
    channel?: SessionEntry["lastChannel"];
    to?: string;
    accountId?: string;
    threadId?: string | number;
    deliveryContext?: DeliveryContext;
    ctx?: MsgContext;
    groupResolution?: import("./types.js").GroupKeyResolution | null;
}): Promise<SessionEntry>;
