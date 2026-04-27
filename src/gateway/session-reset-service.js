import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { getAcpRuntimeBackend } from "../acp/runtime/registry.js";
import { readAcpSessionEntry, upsertAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { clearBootstrapSnapshot } from "../agents/bootstrap-cache.js";
import { retireSessionMcpRuntime } from "../agents/pi-bundle-mcp-tools.js";
import { abortEmbeddedPiRun, waitForEmbeddedPiRunEnd } from "../agents/pi-embedded.js";
import { stopSubagentsForRequester } from "../auto-reply/reply/abort.js";
import { clearSessionQueues } from "../auto-reply/reply/queue.js";
import { buildSessionEndHookPayload, buildSessionStartHookPayload, } from "../auto-reply/reply/session-hooks.js";
import { loadConfig } from "../config/config.js";
import { snapshotSessionOrigin, updateSessionStore, } from "../config/sessions.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../config/sessions/paths.js";
import { resolveResetPreservedSelection } from "../config/sessions/reset-preserved-selection.js";
import { logVerbose } from "../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { closeTrackedBrowserTabsForSessions } from "../plugin-sdk/browser-maintenance.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { isSubagentSessionKey, normalizeAgentId, parseAgentSessionKey, } from "../routing/session-key.js";
import { ErrorCodes, errorShape } from "./protocol/index.js";
import { archiveSessionTranscriptsDetailed, resolveStableSessionEndTranscript, } from "./session-transcript-files.fs.js";
import { loadSessionEntry, migrateAndPruneGatewaySessionStoreKey, readSessionMessages, resolveGatewaySessionStoreTarget, resolveSessionModelRef, } from "./session-utils.js";
const ACP_RUNTIME_CLEANUP_TIMEOUT_MS = 15_000;
function stripRuntimeModelState(entry) {
    if (!entry) {
        return entry;
    }
    return {
        ...entry,
        model: undefined,
        modelProvider: undefined,
        contextTokens: undefined,
        systemPromptReport: undefined,
    };
}
export function archiveSessionTranscriptsForSession(params) {
    return archiveSessionTranscriptsForSessionDetailed(params).map((entry) => entry.archivedPath);
}
export function archiveSessionTranscriptsForSessionDetailed(params) {
    if (!params.sessionId) {
        return [];
    }
    return archiveSessionTranscriptsDetailed({
        sessionId: params.sessionId,
        storePath: params.storePath,
        sessionFile: params.sessionFile,
        agentId: params.agentId,
        reason: params.reason,
    });
}
export function emitGatewaySessionEndPluginHook(params) {
    if (!params.sessionId) {
        return;
    }
    const hookRunner = getGlobalHookRunner();
    if (!hookRunner?.hasHooks("session_end")) {
        return;
    }
    const transcript = resolveStableSessionEndTranscript({
        sessionId: params.sessionId,
        storePath: params.storePath,
        sessionFile: params.sessionFile,
        agentId: params.agentId,
        archivedTranscripts: params.archivedTranscripts,
    });
    const payload = buildSessionEndHookPayload({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        cfg: params.cfg,
        reason: params.reason,
        sessionFile: transcript.sessionFile,
        transcriptArchived: transcript.transcriptArchived,
        nextSessionId: params.nextSessionId,
        nextSessionKey: params.nextSessionKey,
    });
    void hookRunner.runSessionEnd(payload.event, payload.context).catch((err) => {
        logVerbose(`session_end hook failed: ${String(err)}`);
    });
}
export function emitGatewaySessionStartPluginHook(params) {
    if (!params.sessionId) {
        return;
    }
    const hookRunner = getGlobalHookRunner();
    if (!hookRunner?.hasHooks("session_start")) {
        return;
    }
    const payload = buildSessionStartHookPayload({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        cfg: params.cfg,
        resumedFrom: params.resumedFrom,
    });
    void hookRunner.runSessionStart(payload.event, payload.context).catch((err) => {
        logVerbose(`session_start hook failed: ${String(err)}`);
    });
}
export async function emitSessionUnboundLifecycleEvent(params) {
    const targetKind = isSubagentSessionKey(params.targetSessionKey) ? "subagent" : "acp";
    await getSessionBindingService().unbind({
        targetSessionKey: params.targetSessionKey,
        reason: params.reason,
    });
    if (params.emitHooks === false) {
        return;
    }
    const hookRunner = getGlobalHookRunner();
    if (!hookRunner?.hasHooks("subagent_ended")) {
        return;
    }
    await hookRunner.runSubagentEnded({
        targetSessionKey: params.targetSessionKey,
        targetKind,
        reason: params.reason,
        sendFarewell: true,
        outcome: params.reason === "session-reset" ? "reset" : "deleted",
    }, {
        childSessionKey: params.targetSessionKey,
    });
}
async function ensureSessionRuntimeCleanup(params) {
    const closeTrackedBrowserTabs = async () => {
        const closeKeys = new Set([
            params.key,
            params.target.canonicalKey,
            ...params.target.storeKeys,
            params.sessionId ?? "",
        ]);
        return await closeTrackedBrowserTabsForSessions({
            sessionKeys: [...closeKeys],
            onWarn: (message) => logVerbose(message),
        });
    };
    const queueKeys = new Set(params.target.storeKeys);
    queueKeys.add(params.target.canonicalKey);
    if (params.sessionId) {
        queueKeys.add(params.sessionId);
    }
    clearSessionQueues([...queueKeys]);
    stopSubagentsForRequester({ cfg: params.cfg, requesterSessionKey: params.target.canonicalKey });
    if (!params.sessionId) {
        clearBootstrapSnapshot(params.target.canonicalKey);
        await closeTrackedBrowserTabs();
        return undefined;
    }
    abortEmbeddedPiRun(params.sessionId);
    const ended = await waitForEmbeddedPiRunEnd(params.sessionId, 15_000);
    clearBootstrapSnapshot(params.target.canonicalKey);
    if (ended) {
        await retireSessionMcpRuntime({
            sessionId: params.sessionId,
            reason: "gateway-session-cleanup",
            onError: (error, sessionId) => {
                logVerbose(`sessions cleanup: failed to dispose bundle MCP runtime for ${sessionId}: ${String(error)}`);
            },
        });
        await closeTrackedBrowserTabs();
        return undefined;
    }
    return errorShape(ErrorCodes.UNAVAILABLE, `Session ${params.key} is still active; try again in a moment.`);
}
async function runAcpCleanupStep(params) {
    let timer;
    const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ status: "timeout" }), ACP_RUNTIME_CLEANUP_TIMEOUT_MS);
    });
    const opPromise = params
        .op()
        .then(() => ({ status: "ok" }))
        .catch((error) => ({ status: "error", error }));
    const outcome = await Promise.race([opPromise, timeoutPromise]);
    if (timer) {
        clearTimeout(timer);
    }
    return outcome;
}
async function closeAcpRuntimeForSession(params) {
    if (!params.entry?.acp) {
        return undefined;
    }
    const acpManager = getAcpSessionManager();
    const cancelOutcome = await runAcpCleanupStep({
        op: async () => {
            await acpManager.cancelSession({
                cfg: params.cfg,
                sessionKey: params.sessionKey,
                reason: params.reason,
            });
        },
    });
    if (cancelOutcome.status === "timeout") {
        return errorShape(ErrorCodes.UNAVAILABLE, `Session ${params.sessionKey} is still active; try again in a moment.`);
    }
    if (cancelOutcome.status === "error") {
        logVerbose(`sessions.${params.reason}: ACP cancel failed for ${params.sessionKey}: ${String(cancelOutcome.error)}`);
    }
    const closeOutcome = await runAcpCleanupStep({
        op: async () => {
            await acpManager.closeSession({
                cfg: params.cfg,
                sessionKey: params.sessionKey,
                reason: params.reason,
                discardPersistentState: true,
                requireAcpSession: false,
                allowBackendUnavailable: true,
            });
        },
    });
    if (closeOutcome.status === "timeout") {
        return errorShape(ErrorCodes.UNAVAILABLE, `Session ${params.sessionKey} is still active; try again in a moment.`);
    }
    if (closeOutcome.status === "error") {
        logVerbose(`sessions.${params.reason}: ACP runtime close failed for ${params.sessionKey}: ${String(closeOutcome.error)}`);
    }
    await ensureFreshAcpResetState({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        reason: params.reason,
        entry: params.entry,
    });
    return undefined;
}
function buildPendingAcpMeta(base, now) {
    const currentIdentity = base.identity;
    const nextIdentity = currentIdentity
        ? {
            state: "pending",
            ...(currentIdentity.acpxRecordId ? { acpxRecordId: currentIdentity.acpxRecordId } : {}),
            source: currentIdentity.source,
            lastUpdatedAt: now,
        }
        : undefined;
    return {
        backend: base.backend,
        agent: base.agent,
        runtimeSessionName: base.runtimeSessionName,
        ...(nextIdentity ? { identity: nextIdentity } : {}),
        mode: base.mode,
        ...(base.runtimeOptions ? { runtimeOptions: base.runtimeOptions } : {}),
        ...(base.cwd ? { cwd: base.cwd } : {}),
        state: "idle",
        lastActivityAt: now,
    };
}
async function ensureFreshAcpResetState(params) {
    if (params.reason !== "session-reset" || !params.entry?.acp) {
        return;
    }
    const latestMeta = readAcpSessionEntry({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
    })?.acp;
    if (!latestMeta?.identity ||
        latestMeta.identity.state !== "resolved" ||
        (!latestMeta.identity.acpxSessionId && !latestMeta.identity.agentSessionId)) {
        return;
    }
    const backendId = (latestMeta.backend || params.cfg.acp?.backend || "").trim() || undefined;
    try {
        await getAcpRuntimeBackend(backendId)?.runtime.prepareFreshSession?.({
            sessionKey: params.sessionKey,
        });
    }
    catch (error) {
        logVerbose(`sessions.${params.reason}: ACP prepareFreshSession failed for ${params.sessionKey}: ${String(error)}`);
    }
    const now = Date.now();
    await upsertAcpSessionMeta({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        mutate: (current, entry) => {
            const base = current ?? entry?.acp;
            if (!base) {
                return null;
            }
            return buildPendingAcpMeta(base, now);
        },
    });
}
export async function cleanupSessionBeforeMutation(params) {
    const cleanupError = await ensureSessionRuntimeCleanup({
        cfg: params.cfg,
        key: params.key,
        target: params.target,
        sessionId: params.entry?.sessionId,
    });
    if (cleanupError) {
        return cleanupError;
    }
    return await closeAcpRuntimeForSession({
        cfg: params.cfg,
        sessionKey: params.legacyKey ?? params.canonicalKey ?? params.target.canonicalKey ?? params.key,
        entry: params.entry,
        reason: params.reason,
    });
}
function emitGatewayBeforeResetPluginHook(params) {
    const hookRunner = getGlobalHookRunner();
    if (!hookRunner?.hasHooks("before_reset")) {
        return;
    }
    const sessionKey = params.target.canonicalKey ?? params.key;
    const sessionId = params.entry?.sessionId;
    const sessionFile = params.entry?.sessionFile;
    const agentId = normalizeAgentId(params.target.agentId ?? resolveDefaultAgentId(params.cfg));
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
    let messages = [];
    try {
        if (typeof sessionId === "string" && sessionId.trim().length > 0) {
            messages = readSessionMessages(sessionId, params.storePath, sessionFile);
        }
    }
    catch (err) {
        logVerbose(`before_reset: failed to read session messages for ${sessionId ?? "(none)"}; firing hook with empty messages (${String(err)})`);
    }
    void hookRunner
        .runBeforeReset({
        sessionFile,
        messages,
        reason: params.reason,
    }, {
        agentId,
        sessionKey,
        sessionId,
        workspaceDir,
    })
        .catch((err) => {
        logVerbose(`before_reset hook failed: ${String(err)}`);
    });
}
export async function performGatewaySessionReset(params) {
    const { cfg, target, storePath } = (() => {
        const cfg = loadConfig();
        const target = resolveGatewaySessionStoreTarget({ cfg, key: params.key });
        return { cfg, target, storePath: target.storePath };
    })();
    const { entry, legacyKey, canonicalKey } = loadSessionEntry(params.key);
    const hadExistingEntry = Boolean(entry);
    const agentId = normalizeAgentId(target.agentId ?? resolveDefaultAgentId(cfg));
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const hookEvent = createInternalHookEvent("command", params.reason, target.canonicalKey ?? params.key, {
        sessionEntry: entry,
        previousSessionEntry: entry,
        commandSource: params.commandSource,
        cfg,
        workspaceDir,
    });
    await triggerInternalHook(hookEvent);
    const mutationCleanupError = await cleanupSessionBeforeMutation({
        cfg,
        key: params.key,
        target,
        entry,
        legacyKey,
        canonicalKey,
        reason: "session-reset",
    });
    if (mutationCleanupError) {
        return { ok: false, error: mutationCleanupError };
    }
    let oldSessionId;
    let oldSessionFile;
    let resetSourceEntry;
    const next = await updateSessionStore(storePath, (store) => {
        const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({
            cfg,
            key: params.key,
            store,
        });
        const currentEntry = store[primaryKey];
        resetSourceEntry = currentEntry ? { ...currentEntry } : undefined;
        const parsed = parseAgentSessionKey(primaryKey);
        const sessionAgentId = normalizeAgentId(parsed?.agentId ?? resolveDefaultAgentId(cfg));
        const resetPreservedSelection = resolveResetPreservedSelection({
            entry: currentEntry,
        });
        const resetEntry = {
            ...stripRuntimeModelState(currentEntry),
            providerOverride: undefined,
            modelOverride: undefined,
            modelOverrideSource: undefined,
            authProfileOverride: undefined,
            authProfileOverrideSource: undefined,
            authProfileOverrideCompactionCount: undefined,
            ...resetPreservedSelection,
        };
        const resolvedModel = resolveSessionModelRef(cfg, resetEntry, sessionAgentId);
        oldSessionId = currentEntry?.sessionId;
        oldSessionFile = currentEntry?.sessionFile;
        const now = Date.now();
        const nextSessionId = randomUUID();
        const sessionFile = resolveSessionFilePath(nextSessionId, currentEntry?.sessionFile ? { sessionFile: currentEntry.sessionFile } : undefined, resolveSessionFilePathOptions({
            storePath,
            agentId: sessionAgentId,
        }));
        const nextEntry = {
            sessionId: nextSessionId,
            sessionFile,
            updatedAt: now,
            systemSent: false,
            abortedLastRun: false,
            thinkingLevel: currentEntry?.thinkingLevel,
            fastMode: currentEntry?.fastMode,
            verboseLevel: currentEntry?.verboseLevel,
            traceLevel: currentEntry?.traceLevel,
            reasoningLevel: currentEntry?.reasoningLevel,
            elevatedLevel: currentEntry?.elevatedLevel,
            ttsAuto: currentEntry?.ttsAuto,
            execHost: currentEntry?.execHost,
            execSecurity: currentEntry?.execSecurity,
            execAsk: currentEntry?.execAsk,
            execNode: currentEntry?.execNode,
            responseUsage: currentEntry?.responseUsage,
            // Resets should keep the user's explicit selection, but clear any
            // temporary fallback model that was pinned during the previous run.
            ...resetPreservedSelection,
            groupActivation: currentEntry?.groupActivation,
            groupActivationNeedsSystemIntro: currentEntry?.groupActivationNeedsSystemIntro,
            chatType: currentEntry?.chatType,
            model: resolvedModel.model,
            modelProvider: resolvedModel.provider,
            contextTokens: resetEntry?.contextTokens,
            compactionCount: currentEntry?.compactionCount,
            compactionCheckpoints: currentEntry?.compactionCheckpoints,
            sendPolicy: currentEntry?.sendPolicy,
            queueMode: currentEntry?.queueMode,
            queueDebounceMs: currentEntry?.queueDebounceMs,
            queueCap: currentEntry?.queueCap,
            queueDrop: currentEntry?.queueDrop,
            spawnedBy: currentEntry?.spawnedBy,
            spawnedWorkspaceDir: currentEntry?.spawnedWorkspaceDir,
            parentSessionKey: currentEntry?.parentSessionKey,
            forkedFromParent: currentEntry?.forkedFromParent,
            spawnDepth: currentEntry?.spawnDepth,
            subagentRole: currentEntry?.subagentRole,
            subagentControlScope: currentEntry?.subagentControlScope,
            label: currentEntry?.label,
            displayName: currentEntry?.displayName,
            channel: currentEntry?.channel,
            groupId: currentEntry?.groupId,
            subject: currentEntry?.subject,
            groupChannel: currentEntry?.groupChannel,
            space: currentEntry?.space,
            origin: snapshotSessionOrigin(currentEntry),
            deliveryContext: currentEntry?.deliveryContext,
            cliSessionBindings: currentEntry?.cliSessionBindings,
            cliSessionIds: currentEntry?.cliSessionIds,
            claudeCliSessionId: currentEntry?.claudeCliSessionId,
            lastChannel: currentEntry?.lastChannel,
            lastTo: currentEntry?.lastTo,
            lastAccountId: currentEntry?.lastAccountId,
            lastThreadId: currentEntry?.lastThreadId,
            skillsSnapshot: currentEntry?.skillsSnapshot,
            acp: currentEntry?.acp,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            totalTokensFresh: true,
        };
        store[primaryKey] = nextEntry;
        return nextEntry;
    });
    emitGatewayBeforeResetPluginHook({
        cfg,
        key: params.key,
        target,
        storePath,
        entry: resetSourceEntry,
        reason: params.reason,
    });
    const archivedTranscripts = archiveSessionTranscriptsForSessionDetailed({
        sessionId: oldSessionId,
        storePath,
        sessionFile: oldSessionFile,
        agentId: target.agentId,
        reason: "reset",
    });
    fs.mkdirSync(path.dirname(next.sessionFile), { recursive: true });
    if (!fs.existsSync(next.sessionFile)) {
        const header = {
            type: "session",
            version: CURRENT_SESSION_VERSION,
            id: next.sessionId,
            timestamp: new Date().toISOString(),
            cwd: process.cwd(),
        };
        fs.writeFileSync(next.sessionFile, `${JSON.stringify(header)}\n`, {
            encoding: "utf-8",
            mode: 0o600,
        });
    }
    emitGatewaySessionEndPluginHook({
        cfg,
        sessionKey: target.canonicalKey ?? params.key,
        sessionId: oldSessionId,
        storePath,
        sessionFile: oldSessionFile,
        agentId: target.agentId,
        reason: params.reason,
        archivedTranscripts,
        nextSessionId: next.sessionId,
    });
    emitGatewaySessionStartPluginHook({
        cfg,
        sessionKey: target.canonicalKey ?? params.key,
        sessionId: next.sessionId,
        resumedFrom: oldSessionId,
    });
    if (hadExistingEntry) {
        await emitSessionUnboundLifecycleEvent({
            targetSessionKey: target.canonicalKey ?? params.key,
            reason: "session-reset",
        });
    }
    return { ok: true, key: target.canonicalKey, entry: next };
}
