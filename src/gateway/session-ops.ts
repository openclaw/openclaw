import { randomUUID } from "node:crypto";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { clearBootstrapSnapshot } from "../agents/bootstrap-cache.js";
import { abortEmbeddedPiRun, waitForEmbeddedPiRunEnd } from "../agents/pi-embedded.js";
import { stopSubagentsForRequester } from "../auto-reply/reply/abort.js";
import { clearSessionQueues } from "../auto-reply/reply/queue.js";
import { type OpenClawConfig, loadConfig } from "../config/config.js";
import {
  snapshotSessionOrigin,
  updateSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import { unbindThreadBindingsBySessionKey } from "../discord/monitor/thread-bindings.js";
import { logVerbose } from "../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import {
  archiveSessionTranscripts,
  loadSessionEntry,
  pruneLegacyStoreKeys,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelRef,
} from "./session-utils.js";

export type ResetSessionResult =
  | {
      ok: true;
      key: string;
      entry: SessionEntry;
      oldSessionId?: string;
    }
  | {
      ok: false;
      key: string;
      error: string;
    };

// ---------------------------------------------------------------------------
// Cleanup helpers (mirror the local helpers in sessions.ts so the shared
// helper can run the same cleanup steps when called from the plugin SDK)
// ---------------------------------------------------------------------------

const ACP_CLEANUP_TIMEOUT_MS = 15_000;

async function ensureSessionRuntimeCleanup(params: {
  cfg: OpenClawConfig;
  key: string;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  sessionId?: string;
}): Promise<string | undefined> {
  const queueKeys = new Set<string>(params.target.storeKeys);
  queueKeys.add(params.target.canonicalKey);
  if (params.sessionId) {
    queueKeys.add(params.sessionId);
  }
  clearSessionQueues([...queueKeys]);
  clearBootstrapSnapshot(params.target.canonicalKey);
  stopSubagentsForRequester({ cfg: params.cfg, requesterSessionKey: params.target.canonicalKey });
  if (!params.sessionId) {
    return undefined;
  }
  abortEmbeddedPiRun(params.sessionId);
  const ended = await waitForEmbeddedPiRunEnd(params.sessionId, 15_000);
  if (ended) {
    return undefined;
  }
  return `Session ${params.key} is still active; try again in a moment.`;
}

async function runAcpCleanupStep(params: {
  op: () => Promise<void>;
}): Promise<{ status: "ok" } | { status: "timeout" } | { status: "error"; error: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ status: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), ACP_CLEANUP_TIMEOUT_MS);
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
  cfg: OpenClawConfig;
  sessionKey: string;
  entry?: SessionEntry;
  reason: "session-reset";
}): Promise<string | undefined> {
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
    return `Session ${params.sessionKey} is still active; try again in a moment.`;
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
    return `Session ${params.sessionKey} is still active; try again in a moment.`;
  }
  if (closeOutcome.status === "error") {
    logVerbose(
      `sessions.${params.reason}: ACP runtime close failed for ${params.sessionKey}: ${String(closeOutcome.error)}`,
    );
  }
  return undefined;
}

/**
 * Reset a session by key: fire hooks, clean up runtime, mint a new session ID,
 * archive old transcripts, and emit lifecycle events.
 *
 * This is the shared implementation used by both the `sessions.reset` gateway
 * handler and `api.resetSession()` in the plugin SDK.
 */
export async function resetSessionByKey(params: {
  key: string;
  reason?: "new" | "reset";
  commandSource: string;
  /** When called from the gateway handler, the store mutator needs to run
   *  `migrateAndPruneSessionStoreKey` on the store. Pass the function here
   *  so the gateway can inject its migration logic. When omitted (plugin SDK),
   *  the canonical key from `resolveGatewaySessionStoreTarget` is used directly. */
  migrateStore?: (params: {
    cfg: OpenClawConfig;
    key: string;
    store: Record<string, SessionEntry>;
  }) => { primaryKey: string };
}): Promise<ResetSessionResult> {
  const { key, reason = "new", commandSource, migrateStore } = params;

  const cfg = loadConfig();
  const target = resolveGatewaySessionStoreTarget({ cfg, key });
  const { entry, legacyKey, canonicalKey } = loadSessionEntry(key);
  const hadExistingEntry = Boolean(entry);
  const commandReason = reason === "reset" ? "reset" : "new";

  // 1. Fire internal hooks
  const hookEvent = createInternalHookEvent("command", commandReason, target.canonicalKey ?? key, {
    sessionEntry: entry,
    previousSessionEntry: entry,
    commandSource,
    cfg,
  });
  await triggerInternalHook(hookEvent);

  // 2. Runtime cleanup (queues, bootstrap, subagents, embedded Pi)
  const runtimeError = await ensureSessionRuntimeCleanup({
    cfg,
    key,
    target,
    sessionId: entry?.sessionId,
  });
  if (runtimeError) {
    return { ok: false, key: target.canonicalKey ?? key, error: runtimeError };
  }

  // 3. ACP cleanup
  const acpError = await closeAcpRuntimeForSession({
    cfg,
    sessionKey: legacyKey ?? canonicalKey ?? target.canonicalKey ?? key,
    entry,
    reason: "session-reset",
  });
  if (acpError) {
    return { ok: false, key: target.canonicalKey ?? key, error: acpError };
  }

  // 4. Mint new session
  let oldSessionId: string | undefined;
  let oldSessionFile: string | undefined;
  const next = await updateSessionStore(target.storePath, (store) => {
    let primaryKey: string;
    if (migrateStore) {
      const result = migrateStore({ cfg, key, store });
      primaryKey = result.primaryKey;
    } else {
      primaryKey = target.canonicalKey;
      // When called without migrateStore (plugin SDK path), the entry may live
      // under a legacy key that differs from the canonical key. Copy it over so
      // settings are preserved and the store converges to canonical keys.
      if (!store[primaryKey]) {
        const legacySrc =
          (legacyKey && store[legacyKey] ? legacyKey : undefined) ??
          target.storeKeys.find((k) => k !== primaryKey && store[k]);
        if (legacySrc) {
          store[primaryKey] = store[legacySrc];
          delete store[legacySrc];
        }
      }
      // Clean up any remaining legacy/alias keys
      pruneLegacyStoreKeys({
        store,
        canonicalKey: primaryKey,
        candidates: target.storeKeys,
      });
    }
    const existing = store[primaryKey] ?? entry;
    const parsed = parseAgentSessionKey(primaryKey);
    const sessionAgentId = normalizeAgentId(parsed?.agentId ?? resolveDefaultAgentId(cfg));
    const resolvedModel = resolveSessionModelRef(cfg, existing, sessionAgentId);
    oldSessionId = existing?.sessionId;
    oldSessionFile = existing?.sessionFile;
    const now = Date.now();
    const nextEntry: SessionEntry = {
      sessionId: randomUUID(),
      updatedAt: now,
      systemSent: false,
      abortedLastRun: false,
      thinkingLevel: existing?.thinkingLevel,
      verboseLevel: existing?.verboseLevel,
      reasoningLevel: existing?.reasoningLevel,
      responseUsage: existing?.responseUsage,
      model: resolvedModel.model,
      modelProvider: resolvedModel.provider,
      contextTokens: existing?.contextTokens,
      sendPolicy: existing?.sendPolicy,
      label: existing?.label,
      origin: snapshotSessionOrigin(existing),
      lastChannel: existing?.lastChannel,
      lastTo: existing?.lastTo,
      skillsSnapshot: existing?.skillsSnapshot,
      // Reset token counts to 0 on session reset (#1523)
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalTokensFresh: true,
    };
    store[primaryKey] = nextEntry;
    return nextEntry;
  });

  // 5. Archive old transcripts
  if (oldSessionId) {
    archiveSessionTranscripts({
      sessionId: oldSessionId,
      storePath: target.storePath,
      sessionFile: oldSessionFile,
      agentId: target.agentId,
      reason: "reset",
    });
  }

  // 6. Lifecycle events
  if (hadExistingEntry) {
    const targetKind = isSubagentSessionKey(target.canonicalKey) ? "subagent" : "acp";
    unbindThreadBindingsBySessionKey({
      targetSessionKey: target.canonicalKey,
      targetKind,
      reason: "session-reset",
      sendFarewell: true,
    });
    const hookRunner = getGlobalHookRunner();
    if (hookRunner?.hasHooks("subagent_ended")) {
      await hookRunner.runSubagentEnded(
        {
          targetSessionKey: target.canonicalKey,
          targetKind,
          reason: "session-reset",
          sendFarewell: true,
          outcome: "reset",
        },
        {
          childSessionKey: target.canonicalKey,
        },
      );
    }
  }

  return { ok: true, key: target.canonicalKey, entry: next, oldSessionId };
}
