import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { SessionCompactionCheckpoint, SessionCompactionCheckpointReason, SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export type CapturedCompactionCheckpointSnapshot = {
    sessionId: string;
    sessionFile: string;
    leafId: string;
};
export declare function resolveSessionCompactionCheckpointReason(params: {
    trigger?: "budget" | "overflow" | "manual";
    timedOut?: boolean;
}): SessionCompactionCheckpointReason;
export declare function captureCompactionCheckpointSnapshot(params: {
    sessionManager: Pick<SessionManager, "getLeafId">;
    sessionFile: string;
}): CapturedCompactionCheckpointSnapshot | null;
export declare function cleanupCompactionCheckpointSnapshot(snapshot: CapturedCompactionCheckpointSnapshot | null | undefined): Promise<void>;
export declare function persistSessionCompactionCheckpoint(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    sessionId: string;
    reason: SessionCompactionCheckpointReason;
    snapshot: CapturedCompactionCheckpointSnapshot;
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore?: number;
    tokensAfter?: number;
    postSessionFile?: string;
    postLeafId?: string;
    postEntryId?: string;
    createdAt?: number;
}): Promise<SessionCompactionCheckpoint | null>;
export declare function listSessionCompactionCheckpoints(entry: Pick<SessionEntry, "compactionCheckpoints"> | undefined): SessionCompactionCheckpoint[];
export declare function getSessionCompactionCheckpoint(params: {
    entry: Pick<SessionEntry, "compactionCheckpoints"> | undefined;
    checkpointId: string;
}): SessionCompactionCheckpoint | undefined;
