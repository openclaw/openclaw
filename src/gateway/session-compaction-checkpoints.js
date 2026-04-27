import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { updateSessionStore } from "../config/sessions.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGatewaySessionStoreTarget } from "./session-utils.js";
const log = createSubsystemLogger("gateway/session-compaction-checkpoints");
const MAX_COMPACTION_CHECKPOINTS_PER_SESSION = 25;
function trimSessionCheckpoints(checkpoints) {
    if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
        return undefined;
    }
    return checkpoints.slice(-MAX_COMPACTION_CHECKPOINTS_PER_SESSION);
}
function sessionStoreCheckpoints(entry) {
    return Array.isArray(entry?.compactionCheckpoints) ? [...entry.compactionCheckpoints] : [];
}
export function resolveSessionCompactionCheckpointReason(params) {
    if (params.trigger === "manual") {
        return "manual";
    }
    if (params.timedOut) {
        return "timeout-retry";
    }
    if (params.trigger === "overflow") {
        return "overflow-retry";
    }
    return "auto-threshold";
}
export function captureCompactionCheckpointSnapshot(params) {
    const getLeafId = params.sessionManager && typeof params.sessionManager.getLeafId === "function"
        ? params.sessionManager.getLeafId.bind(params.sessionManager)
        : null;
    const sessionFile = params.sessionFile.trim();
    if (!getLeafId || !sessionFile) {
        return null;
    }
    const leafId = getLeafId();
    if (!leafId) {
        return null;
    }
    const parsedSessionFile = path.parse(sessionFile);
    const snapshotFile = path.join(parsedSessionFile.dir, `${parsedSessionFile.name}.checkpoint.${randomUUID()}${parsedSessionFile.ext || ".jsonl"}`);
    try {
        fsSync.copyFileSync(sessionFile, snapshotFile);
    }
    catch {
        return null;
    }
    let snapshotSession;
    try {
        snapshotSession = SessionManager.open(snapshotFile, path.dirname(snapshotFile));
    }
    catch {
        try {
            fsSync.unlinkSync(snapshotFile);
        }
        catch {
            // Best-effort cleanup if the copied transcript cannot be reopened.
        }
        return null;
    }
    const getSessionId = snapshotSession && typeof snapshotSession.getSessionId === "function"
        ? snapshotSession.getSessionId.bind(snapshotSession)
        : null;
    if (!getSessionId) {
        return null;
    }
    return {
        sessionId: getSessionId(),
        sessionFile: snapshotFile,
        leafId,
    };
}
export async function cleanupCompactionCheckpointSnapshot(snapshot) {
    if (!snapshot?.sessionFile) {
        return;
    }
    try {
        await fs.unlink(snapshot.sessionFile);
    }
    catch {
        // Best-effort cleanup; retained snapshots are harmless and easier to debug.
    }
}
export async function persistSessionCompactionCheckpoint(params) {
    const target = resolveGatewaySessionStoreTarget({
        cfg: params.cfg,
        key: params.sessionKey,
    });
    const createdAt = params.createdAt ?? Date.now();
    const checkpoint = {
        checkpointId: randomUUID(),
        sessionKey: target.canonicalKey,
        sessionId: params.sessionId,
        createdAt,
        reason: params.reason,
        ...(typeof params.tokensBefore === "number" ? { tokensBefore: params.tokensBefore } : {}),
        ...(typeof params.tokensAfter === "number" ? { tokensAfter: params.tokensAfter } : {}),
        ...(params.summary?.trim() ? { summary: params.summary.trim() } : {}),
        ...(params.firstKeptEntryId?.trim()
            ? { firstKeptEntryId: params.firstKeptEntryId.trim() }
            : {}),
        preCompaction: {
            sessionId: params.snapshot.sessionId,
            sessionFile: params.snapshot.sessionFile,
            leafId: params.snapshot.leafId,
        },
        postCompaction: {
            sessionId: params.sessionId,
            ...(params.postSessionFile?.trim() ? { sessionFile: params.postSessionFile.trim() } : {}),
            ...(params.postLeafId?.trim() ? { leafId: params.postLeafId.trim() } : {}),
            ...(params.postEntryId?.trim() ? { entryId: params.postEntryId.trim() } : {}),
        },
    };
    let stored = false;
    await updateSessionStore(target.storePath, (store) => {
        const existing = store[target.canonicalKey];
        if (!existing?.sessionId) {
            return;
        }
        const checkpoints = sessionStoreCheckpoints(existing);
        checkpoints.push(checkpoint);
        store[target.canonicalKey] = {
            ...existing,
            updatedAt: Math.max(existing.updatedAt ?? 0, createdAt),
            compactionCheckpoints: trimSessionCheckpoints(checkpoints),
        };
        stored = true;
    });
    if (!stored) {
        log.warn("skipping compaction checkpoint persist: session not found", {
            sessionKey: params.sessionKey,
        });
        return null;
    }
    return checkpoint;
}
export function listSessionCompactionCheckpoints(entry) {
    return sessionStoreCheckpoints(entry).toSorted((a, b) => b.createdAt - a.createdAt);
}
export function getSessionCompactionCheckpoint(params) {
    const checkpointId = params.checkpointId.trim();
    if (!checkpointId) {
        return undefined;
    }
    return listSessionCompactionCheckpoints(params.entry).find((checkpoint) => checkpoint.checkpointId === checkpointId);
}
