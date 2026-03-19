import { randomUUID } from "node:crypto";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { clearBootstrapSnapshot } from "../agents/bootstrap-cache.js";
import { abortEmbeddedPiRun, waitForEmbeddedPiRunEnd } from "../agents/pi-embedded.js";
import { stopSubagentsForRequester } from "../auto-reply/reply/abort.js";
import { clearSessionQueues } from "../auto-reply/reply/queue.js";
import { closeTrackedBrowserTabsForSessions } from "../browser/session-tab-registry.js";
import { loadConfig } from "../config/config.js";
import {
  snapshotSessionOrigin,
  type SessionEntry,
  updateSessionStore,
} from "../config/sessions.js";
import { logVerbose } from "../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { ErrorCodes, errorShape } from "./protocol/index.js";
import {
  archiveSessionTranscripts,
  loadSessionEntry,
  migrateAndPruneGatewaySessionStoreKey,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelRef,
} from "./session-utils.js";

const ACP_RUNTIME_CLEANUP_TIMEOUT_MS = 15_000;
let cachedChannelRuntime: ReturnType<typeof createPluginRuntime>["channel"] | undefined;

function getChannelRuntime() {
  cachedChannelRuntime ??= createPluginRuntime().channel;
  return cachedChannelRuntime;
}

function stripRuntimeModelState(entry?: SessionEntry): SessionEntry | undefined {
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

export function archiveSessionTranscriptsForSession(params: {
  sessionId: string | undefined;
  storePath: string;
  sessionFile?: string;
  agentId?: string;
  reason: "reset" | "deleted";
}): string[] {
  if (!params.sessionId) {
    return [];
  }
  return archiveSessionTranscripts({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
    reason: params.reason,
  });
}

export async function emitSessionUnboundLifecycleEvent(params: {
  targetSessionKey: string;
  reason: "session-reset" | "session-delete";
  emitHooks?: boolean;
}) {
  const targetKind = isSubagentSessionKey(params.targetSessionKey) ? "subagent" : "acp";
  const channelRuntime = getChannelRuntime();
  channelRuntime.discord.threadBindings.unbindBySessionKey({
    targetSessionKey: params.targetSessionKey,
    targetKind,
    reason: params.reason,
    sendFarewell: true,
  });

  if (params.emitHooks === false) {
    return;
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("subagent_ended")) {
    return;
  }
  await hookRunner.runSubagentEnded(
    {
      targetSessionKey: params.targetSessionKey,
      targetKind,
      reason: params.reason,
      sendFarewell: true,
      outcome: params.reason === "session-reset" ? "reset" : "deleted",
    },
    {
      childSessionKey: params.targetSessionKey,
    },
  );
}

async function ensureSessionRuntimeCleanup(params: {
  cfg: ReturnType<typeof loadConfig>;
  key: string;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  sessionId?: string;
}) {
  const closeTrackedBrowserTabs = async () => {
    const closeKeys = new Set<string>([
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

  const queueKeys = new Set<string>(params.target.storeKeys);
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
    await closeTrackedBrowserTabs();
    return undefined;
  }
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    `Session ${params.key} is still active; try again in a moment.`,
  );
}

async function runAcpCleanupStep(params: {
  op: () => Promise<void>;
}): Promise<{ status: "ok" } | { status: "timeout" } | { status: "error"; error: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ status: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), ACP_RUNTIME_CLEANUP_TIMEOUT_MS);
  });
  const opPromise = params
    .op()
    .then(() => ({ status: "ok" as const }))
    .catch((error: unknown) => ({ status: "error" as const, error }));
  const outcome = await Promise.race([opPromise, timeoutPromise]);
  if (timer) {
    clearTimeout(timer);
  }
  return outcome;
}

async function closeAcpRuntimeForSession(params: {
  cfg: ReturnType<typeof loadConfig>;
  sessionKey: string;
  entry?: SessionEntry;
  reason: "session-reset" | "session-delete";
}) {
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
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `Session ${params.sessionKey} is still active; try again in a moment.`,
    );
  }
  if (cancelOutcome.status === "error") {
    logVerbose(
      `sessions.${params.reason}: ACP cancel failed for ${params.sessionKey}: ${String(cancelOutcome.error)}`,
    );
  }

  const closeOutcome = await runAcpCleanupStep({
    op: async () => {
      await acpManager.closeSession({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        reason: params.reason,
        requireAcpSession: false,
        allowBackendUnavailable: true,
      });
    },
  });
  if (closeOutcome.status === "timeout") {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `Session ${params.sessionKey} is still active; try again in a moment.`,
    );
  }
  if (closeOutcome.status === "error") {
    logVerbose(
      `sessions.${params.reason}: ACP runtime close failed for ${params.sessionKey}: ${String(closeOutcome.error)}`,
    );
  }
  return undefined;
}

export async function cleanupSessionBeforeMutation(params: {
  cfg: ReturnType<typeof loadConfig>;
  key: string;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  entry: SessionEntry | undefined;
  legacyKey?: string;
  canonicalKey?: string;
  reason: "session-reset" | "session-delete";
}) {
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

export async function performGatewaySessionReset(params: {
  key: string;
  reason: "new" | "reset";
  commandSource: string;
}): Promise<
  | { ok: true; key: string; entry: SessionEntry }
  | { ok: false; error: ReturnType<typeof errorShape> }
> {
  const { cfg, target, storePath } = (() => {
    const cfg = loadConfig();
    const target = resolveGatewaySessionStoreTarget({ cfg, key: params.key });
    return { cfg, target, storePath: target.storePath };
  })();
  const { entry, legacyKey, canonicalKey } = loadSessionEntry(params.key);
  const hadExistingEntry = Boolean(entry);
  const hookEvent = createInternalHookEvent(
    "command",
    params.reason,
    target.canonicalKey ?? params.key,
    {
      sessionEntry: entry,
      previousSessionEntry: entry,
      commandSource: params.commandSource,
      cfg,
    },
  );
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

  let oldSessionId: string | undefined;
  let oldSessionFile: string | undefined;
  const next = await updateSessionStore(storePath, (store) => {
    const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({
      cfg,
      key: params.key,
      store,
    });
    const currentEntry = store[primaryKey];
    const resetEntry = stripRuntimeModelState(currentEntry);
    const parsed = parseAgentSessionKey(primaryKey);
    const sessionAgentId = normalizeAgentId(parsed?.agentId ?? resolveDefaultAgentId(cfg));
    const resolvedModel = resolveSessionModelRef(cfg, resetEntry, sessionAgentId);
    oldSessionId = currentEntry?.sessionId;
    oldSessionFile = currentEntry?.sessionFile;
    const now = Date.now();
    const nextEntry: SessionEntry = {
      sessionId: randomUUID(),
      updatedAt: now,
      systemSent: false,
      abortedLastRun: false,
      thinkingLevel: currentEntry?.thinkingLevel,
      fastMode: currentEntry?.fastMode,
      verboseLevel: currentEntry?.verboseLevel,
      reasoningLevel: currentEntry?.reasoningLevel,
      responseUsage: currentEntry?.responseUsage,
      model: resolvedModel.model,
      modelProvider: resolvedModel.provider,
      contextTokens: resetEntry?.contextTokens,
      sendPolicy: currentEntry?.sendPolicy,
      label: currentEntry?.label,
      origin: snapshotSessionOrigin(currentEntry),
      lastChannel: currentEntry?.lastChannel,
      lastTo: currentEntry?.lastTo,
      lastAccountId: currentEntry?.lastAccountId,
      lastThreadId: currentEntry?.lastThreadId,
      skillsSnapshot: currentEntry?.skillsSnapshot,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalTokensFresh: true,
    };
    store[primaryKey] = nextEntry;
    return nextEntry;
  });

  archiveSessionTranscriptsForSession({
    sessionId: oldSessionId,
    storePath,
    sessionFile: oldSessionFile,
    agentId: target.agentId,
    reason: "reset",
  });
  if (hadExistingEntry) {
    await emitSessionUnboundLifecycleEvent({
      targetSessionKey: target.canonicalKey ?? params.key,
      reason: "session-reset",
    });
  }
  return { ok: true, key: target.canonicalKey, entry: next };
}
