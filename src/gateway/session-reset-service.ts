// Gateway session reset/delete service.
// Rotates transcripts and coordinates lifecycle cleanup across runtimes/hooks.
import { randomUUID } from "node:crypto";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { type FastMode, normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { tryPrepareFreshManagerRuntimeSession } from "../acp/control-plane/manager.runtime-resume-state.js";
import { getAcpRuntimeBackend } from "../acp/runtime/registry.js";
import { buildAcpDatabaseSessionKey } from "../acp/runtime/session-meta-keys.js";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveAmbientOwnerAgentId,
} from "../agents/agent-scope.js";
import {
  clearBootstrapSnapshot,
  clearBootstrapSnapshotOnSessionBoundary,
} from "../agents/bootstrap-cache.js";
import { clearAllCliSessions } from "../agents/cli-session.js";
import { resetRegisteredAgentHarnessSessions } from "../agents/harness/registry.js";
import { acquireAgentRuntimeCleanupRegistries } from "../agents/prepared-model-runtime.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import {
  buildSessionEndHookPayload,
  buildSessionStartHookPayload,
} from "../auto-reply/reply/session-hooks.js";
import {
  clearSessionResetRuntimeState,
  createSessionResetCleanupGuard,
  SessionResetCleanupError,
  stopSessionResetSubagents,
} from "../auto-reply/reply/session-reset-cleanup.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  isRestartRecoveryTombstone,
  resolveSessionWorkStartError,
  SESSION_LIFECYCLE_CHANGED_ERROR_REASON,
  SESSION_TOTAL_TOKENS_VERSION,
  type InternalSessionEntry,
  type SessionEntry,
  deleteSessionEntryLifecycle,
  resetSessionEntryLifecycle,
} from "../config/sessions.js";
import { rebindCliSessionReseedReceiptsForReset } from "../config/sessions/cli-session-binding.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { resolveResetPreservedSelection } from "../config/sessions/reset-preserved-selection.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { createSessionDiffBaselineCaptureClaim } from "../config/sessions/session-diff-baseline-capture.js";
import { sessionEntryForkedFromParent } from "../config/sessions/session-entry-lineage.js";
import { projectPublicSessionEntry } from "../config/sessions/session-entry-projection.js";
import {
  buildSessionCreationStamp,
  preserveCreationStamp,
  type SessionCreatedActor,
  type SessionCreatedVia,
} from "../config/sessions/session-entry-provenance.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import {
  emitSessionAutoResetHook,
  hasSessionAutoResetListeners,
  isSessionAutoResetReason,
} from "../hooks/session-auto-reset.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { runPluginHostCleanup } from "../plugins/host-hook-cleanup.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../process/gateway-work-admission.js";
import {
  isIncognitoSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { resolveMissingAgentHarnessSessionError } from "../sessions/agent-harness-session-key.js";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_RESET_MESSAGE,
} from "../sessions/model-overrides.js";
import { recordSessionCreated } from "../sessions/session-created.js";
import {
  hasOnlySessionLifecycleMutationKindActive,
  interruptSessionWorkAdmissions,
  isSessionLifecycleMutationActive,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../sessions/session-lifecycle-admission.js";
import {
  handleSessionStateSessionDeleted,
  handleSessionStateSessionReset,
} from "../sessions/session-state-events.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import {
  forgetActiveSessionForShutdown,
  noteActiveSessionForShutdown,
} from "./active-sessions-shutdown-tracker.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "./operator-role-policy.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import type { GatewayOperatorRoleActor } from "./server-methods/shared-types.js";
import type * as SessionLifecycle from "./session-create-service.types.js";
import {
  rollbackGatewaySessionPreparation,
  settleGatewaySessionLifecycleCommit,
} from "./session-lifecycle-preparation.js";
import { resolvePluginSessionOwnershipError } from "./session-plugin-ownership.js";
import { invalidSessionRequest } from "./session-request-error.js";
import {
  buildPendingAcpMeta,
  closeAcpRuntimeForSession,
  closeChildAcpRuntimesForParent,
} from "./session-reset-acp.js";
import { notifyGatewaySessionReset } from "./session-reset-notifications.js";
import { readGatewayBeforeResetPluginHookMessages } from "./session-reset-transcript.js";
import {
  resolveStableSessionEndTranscript,
  type ArchivedSessionTranscript,
} from "./session-transcript-files.fs.js";
import {
  loadSessionEntry,
  resolveGatewaySessionStoreTarget,
  resolveSessionStoreKey,
} from "./session-utils.js";
import type { SessionWorkerPlacementContext } from "./session-worker-placement-context.js";
import {
  resolveSessionWorkerPlacementMutationError,
  retireSessionWorkerPlacementBeforeMutation,
} from "./worker-environments/session-placement-lifecycle.js";

function resolveLifecycleAgentId(cfg: OpenClawConfig, agentId?: string): string {
  return normalizeAgentId(agentId ?? resolveAmbientOwnerAgentId(cfg));
}

async function resetSessionAgentHarnesses(params: {
  cfg: OpenClawConfig;
  key: string;
  target: { agentId?: string; canonicalKey?: string };
  entry: SessionEntry;
  reason: "reset" | "deleted";
  assertCurrent?: () => void;
}): Promise<void> {
  const agentId = resolveLifecycleAgentId(params.cfg, params.target.agentId);
  const sessionKey = params.target.canonicalKey ?? params.key;
  params.assertCurrent?.();
  await using owners = await acquireAgentRuntimeCleanupRegistries(
    resolveAgentDir(params.cfg, agentId),
  );
  params.assertCurrent?.();
  await resetRegisteredAgentHarnessSessions(
    {
      agentId,
      sessionId: params.entry.sessionId,
      sessionKey,
      sessionFile: sessionKey,
      reason: params.reason,
    },
    owners.registries,
  );
  params.assertCurrent?.();
}

type McpRunEndWatcherState = {
  cancellations: Map<string, () => void>;
  retirements: Set<Promise<void>>;
  watchers: Map<string, Promise<void>>;
};

const mcpRunEndWatcherState = resolveGlobalSingleton<McpRunEndWatcherState>(
  Symbol.for("openclaw.mcpRunEndWatchers"),
  () => ({ cancellations: new Map(), retirements: new Set(), watchers: new Map() }),
  async (state) => {
    for (const cancel of state.cancellations.values()) {
      cancel();
    }
    await Promise.allSettled([...state.watchers.values(), ...state.retirements]);
    state.cancellations.clear();
    state.retirements.clear();
    state.watchers.clear();
  },
);
const mcpRunEndWatchers = mcpRunEndWatcherState.watchers;

export function emitGatewaySessionEndPluginHook(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionId?: string;
  storePath: string;
  sessionFile?: string;
  agentId: string;
  workspaceDir?: string;
  reason:
    | "new"
    | "reset"
    | "idle"
    | "daily"
    | "compaction"
    | "deleted"
    | "shutdown"
    | "restart"
    | "unknown";
  archivedTranscripts?: ArchivedSessionTranscript[];
  nextSessionId?: string;
  nextSessionKey?: string;
}): void {
  if (!params.sessionId) {
    return;
  }
  // Drop this session from the shutdown finalizer's tracked set unconditionally
  // -- even when no plugin hooks are registered for `session_end`, the session
  // is being closed here and must not be re-finalized by a later shutdown drain.
  forgetActiveSessionForShutdown(params.sessionId);
  const hookRunner = getGlobalHookRunner();
  const shouldEmitAutoReset =
    isSessionAutoResetReason(params.reason) && hasSessionAutoResetListeners();
  const shouldEmitPluginHook = hookRunner?.hasHooks("session_end") === true;
  if (!shouldEmitAutoReset && !shouldEmitPluginHook) {
    return;
  }
  const transcript = resolveStableSessionEndTranscript({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
    archivedTranscripts: params.archivedTranscripts,
  });
  if (shouldEmitAutoReset) {
    emitSessionAutoResetHook({
      cfg: params.cfg,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      reason: params.reason,
      sessionFile: transcript.sessionFile,
      transcriptArchived: transcript.transcriptArchived,
      nextSessionId: params.nextSessionId,
      nextSessionKey: params.nextSessionKey,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      storePath: params.storePath,
    });
  }
  if (!shouldEmitPluginHook) {
    return;
  }
  if (!hookRunner) {
    return;
  }
  const payload = buildSessionEndHookPayload({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    reason: params.reason,
    sessionFile: transcript.sessionFile,
    transcriptArchived: transcript.transcriptArchived,
    nextSessionId: params.nextSessionId,
    nextSessionKey: params.nextSessionKey,
  });
  void runWithGatewayIndependentRootWorkContinuation(async () => {
    await hookRunner.runSessionEnd(payload.event, payload.context);
  }, "hooks:session-end").catch((err: unknown) => {
    logVerbose(`session_end hook failed: ${String(err)}`);
  });
}

export function emitGatewaySessionStartPluginHook(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionId?: string;
  resumedFrom?: string;
  storePath?: string;
  sessionFile?: string;
  agentId: string;
}): void {
  if (!params.sessionId) {
    return;
  }
  // Track the session for the shutdown finalizer even when no plugin hooks are
  // registered locally, so a later restart still emits a typed `session_end`
  // for sessions that opened while a `session_end` plugin was attached. The
  // tracker is keyed by `sessionId`, so a session that is subsequently closed
  // via reset / delete / compaction is forgotten before the shutdown drain
  // ever runs (see #57790).
  if (params.storePath) {
    noteActiveSessionForShutdown({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      storePath: params.storePath,
      sessionFile: params.sessionFile,
      agentId: params.agentId,
    });
  }
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("session_start")) {
    return;
  }
  const payload = buildSessionStartHookPayload({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    resumedFrom: params.resumedFrom,
  });
  void runWithGatewayIndependentRootWorkContinuation(async () => {
    await hookRunner.runSessionStart(payload.event, payload.context);
  }, "hooks:session-start").catch((err: unknown) => {
    logVerbose(`session_start hook failed: ${String(err)}`);
  });
}

export async function emitSessionUnboundLifecycleEvent(params: {
  targetSessionKey: string;
  reason: "session-reset" | "session-delete";
  emitHooks?: boolean;
}) {
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
  cfg: OpenClawConfig;
  key: string;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  sessionId?: string;
  sessionLifecycleRevision?: string;
  assertCurrent?: () => void;
}) {
  const assertCurrent = createSessionResetCleanupGuard({
    storePath: params.target.storePath,
    sessionKey: params.target.canonicalKey,
    expectedSession: params.sessionId
      ? { sessionId: params.sessionId, lifecycleRevision: params.sessionLifecycleRevision }
      : undefined,
    assertCurrent: params.assertCurrent,
  });
  // Cleanup needs the active-run owner, not the runner and compaction orchestration.
  const [embeddedAgent, mcpTools, { clearFinishedSessionsForScopes }] = await Promise.all([
    import("../agents/embedded-agent-runner/runs.js"),
    import("../agents/agent-bundle-mcp-tools.js"),
    import("../agents/bash-process-registry.js"),
  ]);
  const closeTrackedBrowserTabs = async () => {
    assertCurrent();
    const closeKeys = new Set<string>([
      params.key,
      params.target.canonicalKey,
      ...params.target.storeKeys,
      params.sessionId ?? "",
    ]);
    await cleanupBrowserSessionsForLifecycleEnd({
      cfg: params.cfg,
      sessionKeys: [...closeKeys],
      onWarn: (message) => logVerbose(message),
    });
    assertCurrent();
  };

  try {
    assertCurrent();
    await stopSessionResetSubagents({
      cfg: params.cfg,
      sessionKey: params.target.canonicalKey,
      agentId: resolveLifecycleAgentId(params.cfg, params.target.agentId),
      assertCurrent,
    });
  } catch (error) {
    if (error instanceof SessionResetCleanupError) {
      return errorShape(ErrorCodes.UNAVAILABLE, error.message);
    }
    throw error;
  }
  // Parent admissions are already drained. Reject stale or incomplete child cleanup
  // before discarding queues or interrupting a newly accepted reply operation.
  assertCurrent();
  const queueKeys = new Set<string>(params.target.storeKeys);
  queueKeys.add(params.target.canonicalKey);
  if (params.sessionId) {
    queueKeys.add(params.sessionId);
  }
  // Process scopes may use the requested alias, canonical key, or session id.
  // Clear only completed records so reset/delete cannot erase another scope's
  // output or hide a background process whose owner has not confirmed exit.
  const processScopeKeys = new Set(queueKeys);
  processScopeKeys.add(params.key);
  clearFinishedSessionsForScopes(processScopeKeys);
  await clearSessionResetRuntimeState([...queueKeys], {
    activeReplySessionId: params.sessionId,
    agentId: resolveLifecycleAgentId(params.cfg, params.target.agentId),
  });
  if (!params.sessionId) {
    assertCurrent();
    clearBootstrapSnapshot(params.target.canonicalKey);
    await closeTrackedBrowserTabs();
    return undefined;
  }
  const sessionId = params.sessionId;
  assertCurrent();
  const cleanupProviderResources = () => {
    try {
      cleanupSessionResources(sessionId);
    } catch (error) {
      logVerbose(
        `sessions cleanup: failed to dispose provider resources for ${sessionId}: ${String(error)}`,
      );
    }
  };
  const retireMcpRuntime = async (retainAcrossReuse: boolean) => {
    await mcpTools.retireSessionMcpRuntime({
      sessionId,
      reason: "gateway-session-cleanup",
      preserveActiveLeases: true,
      retainAcrossReuse,
      onError: (error, retiredSessionId) => {
        logVerbose(
          `sessions cleanup: failed to dispose bundle MCP runtime for ${retiredSessionId}: ${String(error)}`,
        );
      },
    });
  };
  const ensureMcpRetirementWatcher = (): Promise<void> => {
    return getOrCreatePromise(
      mcpRunEndWatchers,
      sessionId,
      async () => {
        let cancelWatcher = () => {};
        const cancelled = new Promise<false>((resolve) => {
          cancelWatcher = () => resolve(false);
        });
        mcpRunEndWatcherState.cancellations.set(sessionId, cancelWatcher);
        try {
          while (
            await Promise.race([
              embeddedAgent.waitForEmbeddedAgentRunEnd(sessionId, null),
              cancelled,
            ])
          ) {
            // A replacement can register after the wait promise settles but before
            // this continuation runs. Keep the required retirement armed for it.
            if (embeddedAgent.isEmbeddedAgentRunActive(sessionId)) {
              continue;
            }
            const retirement = retireMcpRuntime(false);
            mcpRunEndWatcherState.retirements.add(retirement);
            try {
              await retirement;
            } finally {
              mcpRunEndWatcherState.retirements.delete(retirement);
            }
            if (embeddedAgent.isEmbeddedAgentRunActive(sessionId)) {
              continue;
            }
            cleanupProviderResources();
            return;
          }
        } catch (error) {
          logVerbose(
            `sessions cleanup: failed to disarm deferred MCP retirement: ${String(error)}`,
          );
        } finally {
          if (mcpRunEndWatcherState.cancellations.get(sessionId) === cancelWatcher) {
            mcpRunEndWatcherState.cancellations.delete(sessionId);
          }
        }
      },
      { evictOnSettled: true },
    );
  };
  // Register against the run being stopped before abort or any await allows a
  // later embedded or reply-backed run to replace it in the active registry.
  const mcpRetirementWatcher = ensureMcpRetirementWatcher();
  embeddedAgent.abortEmbeddedAgentRun(sessionId);
  // Mark cleanup before waiting so the timeout path cannot strand MCP children.
  // Active tool/app leases keep in-flight work alive until their final release.
  await retireMcpRuntime(true);
  const ended = await embeddedAgent.waitForEmbeddedAgentRunEnd(sessionId, 15_000);
  assertCurrent();
  // A stopping run can create or reuse its runtime while we wait. Retire again
  // after a clean stop; otherwise keep the required marker armed for late work.
  await retireMcpRuntime(!ended);
  assertCurrent();
  clearBootstrapSnapshot(params.target.canonicalKey);
  if (ended && !embeddedAgent.isEmbeddedAgentRunActive(sessionId)) {
    assertCurrent();
    mcpRunEndWatcherState.cancellations.get(sessionId)?.();
    await mcpRetirementWatcher;
    assertCurrent();
    cleanupProviderResources();
    await closeTrackedBrowserTabs();
    return undefined;
  }
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    `Session ${params.key} is still active; try again in a moment.`,
  );
}

export async function cleanupSessionBeforeMutation(params: {
  cfg: OpenClawConfig;
  key: string;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  entry: SessionEntry | undefined;
  legacyKey?: string;
  canonicalKey?: string;
  reason: "session-reset" | "session-delete";
  onAcpResetMeta?: (params: { sessionKey: string; meta: SessionAcpMeta }) => void;
  assertCurrent?: () => void;
}) {
  const cleanupError = await ensureSessionRuntimeCleanup({
    cfg: params.cfg,
    key: params.key,
    target: params.target,
    sessionId: params.entry?.sessionId,
    sessionLifecycleRevision: params.entry?.lifecycleRevision,
    assertCurrent: params.assertCurrent,
  });
  if (cleanupError) {
    return cleanupError;
  }
  const pluginCleanup = await runPluginHostCleanup({
    cfg: params.cfg,
    registry: getActivePluginRegistry(),
    reason: params.reason === "session-reset" ? "reset" : "delete",
    sessionKey: params.target.canonicalKey ?? params.key,
    // Unscoped keys can exist in several agent stores; this lifecycle owns only its target.
    sessionStoreTargets: [params.target],
    shouldCleanup: () => {
      params.assertCurrent?.();
      return true;
    },
  });
  params.assertCurrent?.();
  for (const failure of pluginCleanup.failures) {
    logVerbose(
      `plugin host cleanup failed for ${failure.pluginId}/${failure.hookId}: ${String(failure.error)}`,
    );
  }
  const parentSessionKey = params.target.canonicalKey ?? params.canonicalKey ?? params.key;
  const parentAcpError = await closeAcpRuntimeForSession({
    cfg: params.cfg,
    sessionKey: parentSessionKey,
    agentId: params.target.agentId,
    fallbackSessionKeys: [params.canonicalKey, params.legacyKey, params.key],
    reason: params.reason,
    onResetMeta: params.onAcpResetMeta,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent?.();
  await closeChildAcpRuntimesForParent({
    cfg: params.cfg,
    parentKey: params.target.canonicalKey ?? params.canonicalKey ?? params.key,
    parentAgentId: params.target.agentId,
    reason: params.reason,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent?.();
  if (parentAcpError) {
    return parentAcpError;
  }
  if (params.entry?.sessionId) {
    // Clear physical harness ownership after the old run drains but before the
    // store can expose a successor generation to a new turn.
    await resetSessionAgentHarnesses({
      cfg: params.cfg,
      key: params.key,
      target: params.target,
      entry: params.entry,
      reason: params.reason === "session-reset" ? "reset" : "deleted",
      assertCurrent: params.assertCurrent,
    });
    params.assertCurrent?.();
  }
  return undefined;
}

export async function emitGatewayBeforeResetPluginHook(params: {
  cfg: OpenClawConfig;
  key: string;
  messages?: unknown[];
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  storePath: string;
  entry?: SessionEntry;
  reason: "new" | "reset";
}): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_reset")) {
    return;
  }

  const sessionKey = params.target.canonicalKey ?? params.key;
  const sessionId = params.entry?.sessionId;
  const agentId = resolveLifecycleAgentId(params.cfg, params.target.agentId);
  const sessionFile = sessionId
    ? formatSqliteSessionFileMarker({ agentId, sessionId, storePath: params.storePath })
    : undefined;
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
  const messages =
    params.messages ??
    (await readGatewayBeforeResetPluginHookMessages({
      agentId,
      entry: params.entry,
      sessionId,
      sessionKey,
      storePath: params.storePath,
    }));

  void hookRunner
    .runBeforeReset(
      {
        sessionFile,
        messages,
        reason: params.reason,
      },
      {
        agentId,
        sessionKey,
        sessionId,
        workspaceDir,
      },
    )
    .catch((err: unknown) => {
      logVerbose(`before_reset hook failed: ${String(err)}`);
    });
}

export async function performGatewaySessionReset(params: {
  key: string;
  agentId?: string;
  spawnedCwd?: string;
  sessionRoot?: string;
  permissionMode?: SessionEntry["permissionMode"];
  /** Existing-row changes stay admin-gated across reset preparation and commit. */
  fastModeSelection?: { value: FastMode; allowExistingChange: boolean };
  /** Prepares session-owned resources while the target lifecycle fence is held. */
  prepareLifecycle?: SessionLifecycle.PrepareGatewaySessionLifecycle;
  onLifecycleCleanupError?: (error: unknown) => void;
  /** Bind session exec to host=node with this node id; caller scope-checks. */
  execNode?: string;
  /** Working directory interpreted only by execNode. */
  execCwd?: string;
  /** Clear a prior node binding when a new Gateway-host session replaces it. */
  clearExecBinding?: boolean;
  // A plain New Chat must return to the agent workspace instead of inheriting the previous
  // turn's session worktree cwd; only worktree-requested resets carry a spawnedCwd forward.
  clearSpawnedCwd?: boolean;
  reason: "new" | "reset";
  commandSource: string;
  /** Trusted provenance for a reset that materializes a previously missing row. */
  creation?: { via: SessionCreatedVia; actor?: SessionCreatedActor };
  /** Authenticated durable operator identity for missing-session materialization. */
  requestingOperatorProfileId?: string;
  /** Trusted host actor; system-owned resets must identify themselves explicitly. */
  operatorRoleActor?: GatewayOperatorRoleActor;
  /** Exact plugin namespace authorized by the scoped plugin runtime. */
  authorizedPluginId?: string;
  /** Arms local checkout attribution in the authoritative reset commit. */
  armSessionDiffBaselineCapture?: boolean;
  workerPlacementContext?: SessionWorkerPlacementContext;
  assertCurrent?: () => void;
  assertAuthorizedInstance?: () => void;
  /** Optional caller-observed session ID that must still be current at lifecycle admission. */
  expectedSessionId?: string;
  onCommitted?: (commit: { key: string; sessionId: string }) => void;
}): Promise<
  | {
      ok: true;
      key: string;
      entry: SessionEntry;
      resolved: { modelProvider: string; model: string };
      agentId: string;
      storePath: string;
    }
  | {
      ok: true;
      key: string;
      agentId: string;
      storePath: string;
      incognitoDeleted: true;
      deletedSessionId?: string;
    }
  | { ok: false; error: ReturnType<typeof errorShape> }
> {
  const resetTarget = (() => {
    const cfg = getRuntimeConfig();
    const explicitAgentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
    const parsedKey = parseAgentSessionKey(params.key);
    const inferredGlobalAgentId =
      !explicitAgentId &&
      parsedKey &&
      resolveSessionStoreKey({ cfg, sessionKey: params.key }) === "global"
        ? normalizeAgentId(parsedKey.agentId)
        : undefined;
    const requestedAgentId = explicitAgentId ?? inferredGlobalAgentId;
    if (requestedAgentId && !listAgentIds(cfg).includes(requestedAgentId)) {
      return invalidSessionRequest(`Unknown agent id: ${requestedAgentId}`);
    }
    if (
      explicitAgentId &&
      parsedKey?.agentId &&
      normalizeAgentId(parsedKey.agentId) !== explicitAgentId
    ) {
      return invalidSessionRequest("session key agent does not match agentId");
    }
    const target = resolveGatewaySessionStoreTarget({
      cfg,
      key: params.key,
      ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
    });
    return { ok: true as const, cfg, target, storePath: target.storePath, requestedAgentId };
  })();
  if (!resetTarget.ok) {
    return resetTarget;
  }
  const authorizeResetCreation = () =>
    authorizeGatewaySessionCreation({
      cfg: resetTarget.cfg,
      agentId: resetTarget.target.agentId,
      ...(params.operatorRoleActor
        ? { actor: params.operatorRoleActor }
        : { profileId: params.requestingOperatorProfileId }),
    });
  const reportLifecycleCleanupError = (error: unknown) => {
    if (params.onLifecycleCleanupError) {
      params.onLifecycleCleanupError(error);
      return;
    }
    logVerbose(`session lifecycle resource cleanup failed: ${String(error)}`);
  };
  const initialResetEntry = loadSessionEntry(
    params.key,
    resetTarget.requestedAgentId ? { agentId: resetTarget.requestedAgentId } : undefined,
  ).entry;
  const expectedSessionMatches = (entry: SessionEntry | undefined): boolean =>
    params.expectedSessionId === undefined || entry?.sessionId === params.expectedSessionId;
  const sessionChangedError = () =>
    errorShape(ErrorCodes.INVALID_REQUEST, `Session ${params.key} changed before reset. Retry.`, {
      details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON },
    });
  if (!expectedSessionMatches(initialResetEntry)) {
    return { ok: false, error: sessionChangedError() };
  }
  if (!initialResetEntry) {
    const creationError = authorizeResetCreation();
    if (creationError) {
      return { ok: false, error: creationError };
    }
  }
  const initialOwnershipError = resolvePluginSessionOwnershipError({
    action: "reset",
    entry: initialResetEntry,
    key: resetTarget.target.canonicalKey,
    pluginOwnerId: params.authorizedPluginId,
  });
  if (initialOwnershipError) {
    return { ok: false, error: initialOwnershipError };
  }
  const resolveFastModeSelectionError = (entry: SessionEntry | undefined) => {
    const selection = params.fastModeSelection;
    return entry &&
      selection &&
      selection.value !== entry.fastMode &&
      !selection.allowExistingChange
      ? missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] })
      : undefined;
  };
  const initialFastModeSelectionError = resolveFastModeSelectionError(initialResetEntry);
  if (initialFastModeSelectionError) {
    return { ok: false, error: initialFastModeSelectionError };
  }
  const missingHarnessSessionError = resolveMissingAgentHarnessSessionError(
    resetTarget.target.canonicalKey,
    initialResetEntry,
  );
  if (missingHarnessSessionError) {
    return invalidSessionRequest(missingHarnessSessionError);
  }
  // Reject before interrupting admitted work or firing reset hooks. The model lock is
  // session-id scoped, so rotating first would silently detach native harness ownership.
  if (isModelSelectionLocked(initialResetEntry)) {
    return invalidSessionRequest(MODEL_SELECTION_LOCKED_RESET_MESSAGE);
  }
  const workerPlacementContext =
    params.workerPlacementContext ??
    (await import("./session-worker-placement-context.js")).resolveSessionWorkerPlacementContext();
  const resolveResetEntryStateError = (entry: SessionEntry | undefined, canonicalKey: string) => {
    const placementError = resolveSessionWorkerPlacementMutationError({
      action: "reset",
      context: workerPlacementContext,
      key: params.key,
      sessionId: normalizeOptionalString(entry?.sessionId),
    });
    if (placementError) {
      return errorShape(ErrorCodes.INVALID_REQUEST, placementError.message);
    }
    // Reset drains pending preparation before replacing the session.
    const archivedSessionError = resolveSessionWorkStartError(canonicalKey, entry, {
      allowPendingWorkspace: true,
      allowRestartTombstoneReplacement:
        entry !== undefined && entry.archivedAt === undefined && isRestartRecoveryTombstone(entry),
    });
    if (archivedSessionError) {
      return errorShape(ErrorCodes.INVALID_REQUEST, archivedSessionError);
    }
    if (isModelSelectionLocked(entry)) {
      return errorShape(ErrorCodes.INVALID_REQUEST, MODEL_SELECTION_LOCKED_RESET_MESSAGE);
    }
    if (!entry && isIncognitoSessionKey(resetTarget.target.canonicalKey)) {
      return errorShape(ErrorCodes.INVALID_REQUEST, `unknown session: ${params.key}`);
    }
    return undefined;
  };
  const initialPlacementError = resolveSessionWorkerPlacementMutationError({
    action: "reset",
    context: workerPlacementContext,
    key: params.key,
    sessionId: normalizeOptionalString(initialResetEntry?.sessionId),
  });
  if (initialPlacementError) {
    return invalidSessionRequest(initialPlacementError.message);
  }
  const resetLifecycleIdentities = [
    resetTarget.target.canonicalKey,
    params.key,
    initialResetEntry?.sessionId,
  ];
  const activeLifecycleMutation = isSessionLifecycleMutationActive(
    resetTarget.storePath,
    resetLifecycleIdentities,
  );
  const activeCompaction = hasOnlySessionLifecycleMutationKindActive(
    resetTarget.storePath,
    resetLifecycleIdentities,
    "compaction",
  );
  if (activeLifecycleMutation && !activeCompaction) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        `Session ${params.key} has another lifecycle mutation in progress; try again.`,
      ),
    };
  }
  let admittedWorkReleased = true;
  let resetPreparationError: ReturnType<typeof errorShape> | undefined;
  let preparedResetSessionId: string | undefined;
  let preparedLifecycle: SessionLifecycle.PreparedGatewaySessionLifecycle | undefined;
  let lifecyclePreparationCommitted = false;
  return await runExclusiveSessionLifecycleMutation({
    scope: resetTarget.storePath,
    identities: resetLifecycleIdentities,
    // Mark the mutation first, then interrupt outside the identity lock. This
    // lets aborted runs finish admission cleanup without deadlocking reset.
    prepare: async () => {
      params.assertCurrent?.();
      params.assertAuthorizedInstance?.();
      const { entry: currentEntry, canonicalKey: currentCanonicalKey } = loadSessionEntry(
        params.key,
        resetTarget.requestedAgentId ? { agentId: resetTarget.requestedAgentId } : undefined,
      );
      if (!expectedSessionMatches(currentEntry)) {
        resetPreparationError = sessionChangedError();
        return;
      }
      if (!currentEntry) {
        resetPreparationError = authorizeResetCreation();
        if (resetPreparationError) {
          return;
        }
      }
      resetPreparationError = resolveFastModeSelectionError(currentEntry);
      if (resetPreparationError) {
        return;
      }
      // Check the locked generation before interrupting any work; a replaced
      // foreign row must not be reset or have its admitted run cancelled.
      resetPreparationError = resolvePluginSessionOwnershipError({
        action: "reset",
        entry: currentEntry,
        key: resetTarget.target.canonicalKey,
        pluginOwnerId: params.authorizedPluginId,
      });
      if (resetPreparationError) {
        return;
      }
      const currentMissingHarnessSessionError = resolveMissingAgentHarnessSessionError(
        resetTarget.target.canonicalKey,
        currentEntry,
      );
      if (currentMissingHarnessSessionError) {
        resetPreparationError = errorShape(
          ErrorCodes.INVALID_REQUEST,
          currentMissingHarnessSessionError,
        );
        return;
      }
      resetPreparationError = resolveResetEntryStateError(currentEntry, currentCanonicalKey);
      if (resetPreparationError) {
        return;
      }
      preparedResetSessionId = normalizeOptionalString(currentEntry?.sessionId);
      admittedWorkReleased = await interruptSessionWorkAdmissions({
        scope: resetTarget.storePath,
        identities: resetLifecycleIdentities,
        timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
      });
      if (admittedWorkReleased && params.prepareLifecycle) {
        const prepared = await params.prepareLifecycle({
          agentId: resetTarget.target.agentId,
          entry: currentEntry,
          key: resetTarget.target.canonicalKey,
          storePath: resetTarget.storePath,
        });
        if (!prepared.ok) {
          resetPreparationError = prepared.error;
          return;
        }
        preparedLifecycle = prepared.value;
      }
    },
    run: async () => {
      const { cfg, target, storePath, requestedAgentId } = resetTarget;
      if (resetPreparationError) {
        return { ok: false, error: resetPreparationError };
      }
      if (!admittedWorkReleased) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.UNAVAILABLE,
            `Session ${params.key} is still active; try again in a moment.`,
          ),
        };
      }
      params.assertCurrent?.();
      params.assertAuthorizedInstance?.();
      const { entry, legacyKey, canonicalKey } = loadSessionEntry(
        params.key,
        requestedAgentId ? { agentId: requestedAgentId } : undefined,
      );
      if (normalizeOptionalString(entry?.sessionId) !== preparedResetSessionId) {
        return {
          ok: false,
          error:
            params.expectedSessionId === undefined
              ? errorShape(
                  ErrorCodes.UNAVAILABLE,
                  `Session ${params.key} changed before reset. Retry.`,
                )
              : sessionChangedError(),
        };
      }
      // Admitted directives can finish persisting while reset drains them.
      // Recheck their final selection before retiring placement or running cleanup.
      const currentFastModeSelectionError = resolveFastModeSelectionError(entry);
      if (currentFastModeSelectionError) {
        return { ok: false, error: currentFastModeSelectionError };
      }
      const currentOwnershipError = resolvePluginSessionOwnershipError({
        action: "reset",
        entry,
        key: canonicalKey,
        pluginOwnerId: params.authorizedPluginId,
      });
      if (currentOwnershipError) {
        return { ok: false, error: currentOwnershipError };
      }
      const entryStateError = resolveResetEntryStateError(entry, canonicalKey);
      if (entryStateError) {
        return { ok: false, error: entryStateError };
      }
      const incognito = entry?.incognito === true || isIncognitoSessionKey(target.canonicalKey);
      // Drain first so a legitimate local turn can release its claim. Retire only
      // after every non-destructive guard is rechecked; a placement race must abort
      // before hooks, runtime cleanup, or session mutation begins.
      const placementRetirementError = retireSessionWorkerPlacementBeforeMutation({
        action: "reset",
        context: workerPlacementContext,
        key: params.key,
        sessionId: normalizeOptionalString(entry?.sessionId),
      });
      if (placementRetirementError) {
        return invalidSessionRequest(placementRetirementError.message);
      }
      if (entry?.worktree?.id) {
        const record = managedWorktrees.findLiveById(entry.worktree.id);
        if (record) {
          const { withSettledLocalWorkspace } =
            await import("./worker-environments/local-workspace-projection.js");
          await withSettledLocalWorkspace(
            { worktree: record, assertCurrent: params.assertCurrent, retireRuntime: true },
            async () => {},
          );
        }
      }
      const hadExistingEntry = Boolean(entry);
      const detachedWorktreeId = params.clearSpawnedCwd
        ? normalizeOptionalString(entry?.worktree?.id)
        : undefined;
      const resetLifecycleRevision = entry?.lifecycleRevision;
      const agentId = resolveLifecycleAgentId(cfg, target.agentId);
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const resetPluginRegistry = getActivePluginRegistry();
      const isResetLifecycleCurrent = () => {
        try {
          params.assertCurrent?.();
          return true;
        } catch {
          return false;
        }
      };
      let deferredAcpResetState: { sessionKey: string; meta: SessionAcpMeta } | undefined;
      const hookEvent = createInternalHookEvent(
        "command",
        params.reason,
        target.canonicalKey ?? params.key,
        {
          agentId,
          sessionEntry: entry,
          previousSessionEntry: entry,
          commandSource: params.commandSource,
          cfg,
          storePath,
          workspaceDir,
        },
      );
      await triggerInternalHook(hookEvent);
      params.assertCurrent?.();
      params.assertAuthorizedInstance?.();
      // Destructive cleanup adopts only this existing generation. Finish its durable
      // transition after caller closure; missing-row creation still needs live authority.
      const assertCompletionAuthorized = hadExistingEntry
        ? undefined
        : () => {
            params.assertCurrent?.();
            params.assertAuthorizedInstance?.();
          };
      const runtimeCleanupError = await ensureSessionRuntimeCleanup({
        cfg,
        key: params.key,
        target,
        sessionId: entry?.sessionId,
        sessionLifecycleRevision: resetLifecycleRevision,
      });
      if (runtimeCleanupError) {
        return { ok: false, error: runtimeCleanupError };
      }
      const parentSessionKey = target.canonicalKey ?? canonicalKey ?? params.key;
      const parentAcpError = await closeAcpRuntimeForSession({
        cfg,
        sessionKey: parentSessionKey,
        agentId: target.agentId,
        fallbackSessionKeys: [canonicalKey, legacyKey, params.key],
        reason: "session-reset",
        deferResetState: true,
        onDeferredResetState: (state) => {
          deferredAcpResetState = state;
        },
      });
      if (parentAcpError) {
        return { ok: false, error: parentAcpError };
      }
      const pluginCleanup = await runPluginHostCleanup({
        cfg,
        registry: resetPluginRegistry,
        reason: "reset",
        sessionKey: target.canonicalKey ?? params.key,
        skipPersistentSessionState: true,
      });
      for (const failure of pluginCleanup.failures) {
        logVerbose(
          `plugin host cleanup failed for ${failure.pluginId}/${failure.hookId}: ${String(failure.error)}`,
        );
      }
      await closeChildAcpRuntimesForParent({
        cfg,
        parentKey: target.canonicalKey ?? canonicalKey ?? params.key,
        parentAgentId: target.agentId,
        reason: "session-reset",
      });
      if (entry?.sessionId) {
        await resetSessionAgentHarnesses({
          cfg,
          key: params.key,
          target,
          entry,
          reason: "reset",
        });
      }
      const beforeResetMessages = getGlobalHookRunner()?.hasHooks("before_reset")
        ? await readGatewayBeforeResetPluginHookMessages({
            agentId: resolveLifecycleAgentId(cfg, target.agentId ?? requestedAgentId),
            entry,
            sessionId: entry?.sessionId,
            sessionKey: target.canonicalKey ?? params.key,
            storePath,
          })
        : undefined;

      const { prepareSubagentSessionCleanupRevocation } =
        await import("../agents/subagents/registry/subagent-registry.js");
      const revokeSessionCleanup = prepareSubagentSessionCleanupRevocation(target.canonicalKey);
      const commitGuard = () => {
        assertCompletionAuthorized?.();
        const current = loadSessionEntryReadOnly({
          agentId,
          storePath,
          sessionKey: target.canonicalKey,
          clone: false,
        });
        if (
          current?.sessionId === entry?.sessionId &&
          current?.lifecycleRevision === resetLifecycleRevision
        ) {
          // Revoke durably before publishing the successor. A later reset failure may
          // retain the old session, but must never restore its stale deletion authority.
          revokeSessionCleanup();
        }
      };

      if (incognito) {
        if (!entry) {
          return invalidSessionRequest(`unknown session: ${params.key}`);
        }
        await emitGatewayBeforeResetPluginHook({
          cfg,
          key: params.key,
          messages: beforeResetMessages,
          target,
          storePath,
          entry,
          reason: params.reason,
        });
        const deleted = await deleteSessionEntryLifecycle({
          commitGuard,
          agentId: target.agentId,
          archiveTranscript: false,
          deleteDeliveryArtifacts: true,
          deleteTranscriptWithoutArchive: true,
          expectedEntry: entry,
          expectedSessionId: entry.sessionId,
          expectedUpdatedAt: entry.updatedAt,
          storePath,
          target: {
            canonicalKey: target.canonicalKey,
            storeKeys: target.storeKeys,
          },
        });
        if (!deleted.deleted) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.UNAVAILABLE,
              `Session ${params.key} changed before reset. Retry.`,
            ),
          };
        }
        handleSessionStateSessionDeleted(target.canonicalKey, agentId);
        notifyGatewaySessionReset(target.canonicalKey, target.agentId);
        emitGatewaySessionEndPluginHook({
          cfg,
          sessionKey: target.canonicalKey,
          sessionId: entry.sessionId,
          storePath,
          sessionFile: target.canonicalKey,
          agentId: target.agentId,
          reason: params.reason,
          archivedTranscripts: [],
        });
        await emitSessionUnboundLifecycleEvent({
          targetSessionKey: target.canonicalKey,
          reason: "session-reset",
        });
        return {
          ok: true,
          key: target.canonicalKey,
          agentId: target.agentId,
          storePath,
          incognitoDeleted: true,
          deletedSessionId: deleted.deletedSessionId,
        };
      }

      let createdNewEntry = false;
      assertCompletionAuthorized?.();
      const boundaryEntry = loadSessionEntry(
        params.key,
        requestedAgentId ? { agentId: requestedAgentId } : undefined,
      ).entry;
      if (boundaryEntry?.sessionId !== entry?.sessionId) {
        params.assertCurrent?.();
        throw new Error(`Session ${params.key} changed before reset boundary append.`);
      }
      let resetBoundaryAppended = false;
      let resetSkipped = false;
      let creationAuthorizationError: ReturnType<typeof errorShape> | undefined;
      let fastModeSelectionError: ReturnType<typeof missingScopeErrorShape> | undefined;
      const postCommitActions: Array<() => void | Promise<void>> = [];
      const lifecycleRequest: Parameters<typeof resetSessionEntryLifecycle>[0] = {
        commitGuard,
        archivePreviousTranscript: false,
        agentId: target.agentId,
        resetBoundary: boundaryEntry
          ? { context: "clear", reason: params.reason, cwd: workspaceDir }
          : undefined,
        storePath,
        target: {
          canonicalKey: target.canonicalKey,
          storeKeys: [
            ...new Set(
              [...target.storeKeys, canonicalKey, legacyKey, params.key].filter(
                (key): key is string => Boolean(key),
              ),
            ),
          ],
        },
        buildNextEntry: ({ currentEntry, primaryKey }) => {
          assertCompletionAuthorized?.();
          if (!currentEntry) {
            creationAuthorizationError = authorizeResetCreation();
            if (creationAuthorizationError) {
              throw new Error(creationAuthorizationError.message);
            }
          }
          createdNewEntry = currentEntry === undefined;
          fastModeSelectionError = resolveFastModeSelectionError(currentEntry);
          if (fastModeSelectionError) {
            throw new Error(fastModeSelectionError.message);
          }
          if (currentEntry?.sessionId !== boundaryEntry?.sessionId) {
            if (currentEntry) {
              resetSkipped = true;
              return currentEntry;
            }
            params.assertCurrent?.();
            throw new Error(`Session ${params.key} changed before reset boundary commit.`);
          }
          if (currentEntry && currentEntry.lifecycleRevision !== resetLifecycleRevision) {
            // A newer owner already replaced or removed the session while cleanup
            // targeted the old lifecycle. Preserve that newer state instead of resetting it.
            resetSkipped = true;
            return currentEntry;
          }
          resetBoundaryAppended = currentEntry !== undefined;
          const resetPreservedSelection = resolveResetPreservedSelection({
            entry: currentEntry,
          });
          const now = Date.now();
          const nextSessionId = currentEntry?.sessionId ?? randomUUID();
          const nextExecNode = params.execNode
            ? params.execNode
            : params.clearExecBinding
              ? undefined
              : currentEntry?.execNode;
          const creationStamp = currentEntry
            ? {
                ...preserveCreationStamp({}, currentEntry),
                projectId: currentEntry.projectId,
              }
            : params.creation
              ? {
                  ...buildSessionCreationStamp(params.creation),
                  ...(resolveCreatorSandbox(cfg, params.creation) === "required"
                    ? { sandbox: "required" as const }
                    : {}),
                }
              : {};
          const nextEntry: InternalSessionEntry = {
            sessionId: nextSessionId,
            lifecycleRevision: randomUUID(),
            updatedAt: now,
            sessionStartedAt: now,
            systemSent: false,
            abortedLastRun: false,
            contextWindow: currentEntry?.contextWindow,
            thinkingLevel: currentEntry?.thinkingLevel,
            fastMode: params.fastModeSelection?.value ?? currentEntry?.fastMode,
            toolOverrides: currentEntry?.toolOverrides,
            verboseLevel: currentEntry?.verboseLevel,
            traceLevel: currentEntry?.traceLevel,
            reasoningLevel: currentEntry?.reasoningLevel,
            elevatedLevel: currentEntry?.elevatedLevel,
            ttsAuto: currentEntry?.ttsAuto,
            execHost: params.execNode
              ? "node"
              : params.clearExecBinding
                ? undefined
                : currentEntry?.execHost,
            execNode: nextExecNode,
            execCwd: params.execNode
              ? params.execCwd
              : params.clearExecBinding
                ? undefined
                : currentEntry?.execCwd,
            ...(params.armSessionDiffBaselineCapture && !nextExecNode
              ? {
                  sessionDiffBaselineCapture: createSessionDiffBaselineCaptureClaim(),
                }
              : {}),
            responseUsage: currentEntry?.responseUsage,
            pinnedAt: currentEntry?.pinnedAt,
            // Resets should keep the user's explicit selection, but clear any
            // temporary fallback model that was pinned during the previous run.
            ...resetPreservedSelection,
            groupActivation: currentEntry?.groupActivation,
            groupActivationNeedsSystemIntro: currentEntry?.groupActivationNeedsSystemIntro,
            chatType: currentEntry?.chatType,
            compactionCount: 0,
            sendPolicy: currentEntry?.sendPolicy,
            queueMode: currentEntry?.queueMode,
            queueDebounceMs: currentEntry?.queueDebounceMs,
            queueCap: currentEntry?.queueCap,
            queueDrop: currentEntry?.queueDrop,
            spawnedBy: currentEntry?.spawnedBy,
            completionOwnerSessionKey: currentEntry?.completionOwnerSessionKey,
            inheritedToolPolicyVersion: currentEntry?.inheritedToolPolicyVersion,
            inheritedToolAllow: currentEntry?.inheritedToolAllow,
            inheritedToolDeny: currentEntry?.inheritedToolDeny,
            spawnedWorkspaceDir: currentEntry?.spawnedWorkspaceDir,
            spawnedCwd: params.clearSpawnedCwd
              ? undefined
              : (preparedLifecycle?.spawnedCwd ?? params.spawnedCwd ?? currentEntry?.spawnedCwd),
            sessionRoot: params.clearSpawnedCwd
              ? undefined
              : (preparedLifecycle?.sessionRoot ?? params.sessionRoot ?? currentEntry?.sessionRoot),
            permissionMode: params.clearSpawnedCwd
              ? undefined
              : (params.permissionMode ?? currentEntry?.permissionMode),
            // Reset keeps this logical chat's authorized containment choice.
            sandboxMode: currentEntry?.sandboxMode,
            worktree: params.clearSpawnedCwd
              ? undefined
              : (preparedLifecycle?.worktree ?? currentEntry?.worktree),
            repositoryWorkspaceId:
              preparedLifecycle?.repositoryWorkspaceId ?? currentEntry?.repositoryWorkspaceId,
            parentSessionKey: currentEntry?.parentSessionKey,
            parentSessionId: currentEntry?.parentSessionId,
            ...creationStamp,
            forkSource: currentEntry?.forkSource,
            forkedFromParent: sessionEntryForkedFromParent(currentEntry) ? true : undefined,
            spawnDepth: currentEntry?.spawnDepth,
            subagentRole: currentEntry?.subagentRole,
            subagentControlScope: currentEntry?.subagentControlScope,
            label: currentEntry?.label,
            autoLabel: currentEntry?.autoLabel,
            icon: currentEntry?.icon,
            category: currentEntry?.category,
            boardFace: currentEntry?.boardFace,
            boardPresentation: currentEntry?.boardPresentation,
            visibility: currentEntry?.visibility,
            displayName: currentEntry?.displayName,
            delivery: currentEntry?.delivery,
            pendingDeliveryNotice: currentEntry?.pendingDeliveryNotice,
            groupId: currentEntry?.groupId,
            subject: currentEntry?.subject,
            groupChannel: currentEntry?.groupChannel,
            space: currentEntry?.space,
            pluginOwnerId: currentEntry?.pluginOwnerId ?? params.authorizedPluginId,
            cliSessionBindings: currentEntry?.cliSessionBindings,
            cliSessionIds: currentEntry?.cliSessionIds,
            claudeCliSessionId: currentEntry?.claudeCliSessionId,
            usageFamilyKey: currentEntry?.usageFamilyKey,
            usageFamilySessionIds: currentEntry?.usageFamilySessionIds,
            // Do not carry the cached skills catalog across /new. Long-lived channel
            // sessions (Signal DMs/groups in particular) otherwise keep advertising a
            // stale <available_skills> block even after reset/restart, because the
            // skills snapshot version is runtime-local and may reset to 0.
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            totalTokensFresh: true,
            totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
          };
          // Drop CLI provider bindings so the next turn after reset starts a fresh
          // CLI conversation on the provider side. Preserved only for spawned
          // subagents (canonical `:subagent:` keys), where Tak Hoffman's fa56682b3ced
          // regression fix intentionally protects CLI continuity for
          // orchestration-driven resets. Non-subagent sessions that happen to set
          // `parentSessionKey` (e.g. dashboard children) are not exempt.
          if (resetBoundaryAppended && !isSubagentSessionKey(primaryKey)) {
            clearAllCliSessions(nextEntry);
          } else {
            nextEntry.cliSessionBindings = rebindCliSessionReseedReceiptsForReset(
              nextEntry.cliSessionBindings,
              nextSessionId,
            );
          }
          return nextEntry;
        },
        afterEntryMutation: (mutation) => {
          if (resetSkipped) {
            return;
          }
          lifecyclePreparationCommitted = true;
          let committedAcpResetState: { sessionKey: string; meta: SessionAcpMeta } | undefined;
          // Record completion before synchronous publications can fail after the row commits.
          postCommitActions.push(
            async () => {
              if (committedAcpResetState && isResetLifecycleCurrent()) {
                await tryPrepareFreshManagerRuntimeSession({
                  deps: { getRuntimeBackend: getAcpRuntimeBackend },
                  cfg,
                  meta: committedAcpResetState.meta,
                  sessionKey: committedAcpResetState.sessionKey,
                  agentId,
                  logPrefix: "sessions.session-reset",
                });
              }
              await emitGatewayBeforeResetPluginHook({
                cfg,
                key: params.key,
                messages: beforeResetMessages,
                target,
                storePath,
                entry: mutation.previousEntry,
                reason: params.reason,
              });
            },
            () => {
              const resetSessionKey = target.canonicalKey ?? params.key;
              handleSessionStateSessionReset(resetSessionKey);
              notifyGatewaySessionReset(resetSessionKey, target.agentId);
              emitGatewaySessionEndPluginHook({
                cfg,
                sessionKey: resetSessionKey,
                sessionId: mutation.previousSessionId,
                storePath,
                sessionFile: mutation.previousSessionFile,
                agentId: target.agentId,
                reason: params.reason,
                archivedTranscripts: [],
                nextSessionId: mutation.nextEntry.sessionId,
              });
              emitGatewaySessionStartPluginHook({
                cfg,
                sessionKey: resetSessionKey,
                sessionId: mutation.nextEntry.sessionId,
                resumedFrom: mutation.previousSessionId,
                storePath,
                sessionFile: resetSessionKey,
                agentId: target.agentId,
              });
            },
          );
          if (hadExistingEntry) {
            postCommitActions.push(() =>
              emitSessionUnboundLifecycleEvent({
                targetSessionKey: target.canonicalKey ?? params.key,
                reason: "session-reset",
              }),
            );
          }
          if (detachedWorktreeId) {
            postCommitActions.push(async () => {
              // Finalize the old checkout before the fence opens to same-key successors.
              try {
                if (!(await managedWorktrees.removeIfLossless(detachedWorktreeId))) {
                  const retained = managedWorktrees.findLiveById(detachedWorktreeId);
                  if (retained) {
                    const safePath = truncateUtf16Safe(sanitizeForLog(retained.path), 256);
                    reportLifecycleCleanupError(
                      new Error(
                        `worktree retained: branch=${retained.branch} path=${safePath} outcome=${retained.runEndCleanup?.outcome}`,
                      ),
                    );
                  }
                }
              } catch (error) {
                reportLifecycleCleanupError(error);
              }
            });
          }
          clearBootstrapSnapshotOnSessionBoundary({
            boundaryAppended: resetBoundaryAppended,
            sessionKey: target.canonicalKey ?? params.key,
          });
          if (createdNewEntry) {
            recordSessionCreated(cfg, {
              sessionKey: target.canonicalKey ?? params.key,
              agentId,
              entry: mutation.nextEntry,
            });
          }
          if (deferredAcpResetState) {
            const resetState = {
              sessionKey: target.canonicalKey,
              meta: buildPendingAcpMeta(deferredAcpResetState.meta, Date.now()),
            };
            // Bind the captured ACP shell to the committed canonical entry, including
            // fallback/legacy metadata. Never recreate a consumed alias.
            writeAcpSessionMetaForMigration({
              sessionKey: buildAcpDatabaseSessionKey(target.canonicalKey, agentId),
              sessionId: mutation.nextEntry.sessionId,
              lifecycleRevision: mutation.nextEntry.lifecycleRevision,
              meta: resetState.meta,
            });
            committedAcpResetState = resetState;
          }
          params.onCommitted?.({
            key: target.canonicalKey,
            sessionId: mutation.nextEntry.sessionId,
          });
        },
      };
      const resetLifecycle = async (assertSourceCurrent?: () => void) =>
        await resetSessionEntryLifecycle({
          ...lifecycleRequest,
          commitGuard: () => {
            commitGuard();
            assertSourceCurrent?.();
          },
        });
      const lifecyclePromise = preparedLifecycle?.withCommit
        ? preparedLifecycle.withCommit(resetLifecycle)
        : resetLifecycle();
      let lifecycle: Awaited<ReturnType<typeof resetSessionEntryLifecycle>>;
      try {
        lifecycle = await settleGatewaySessionLifecycleCommit(lifecyclePromise, postCommitActions);
      } catch (error) {
        if (fastModeSelectionError) {
          return { ok: false, error: fastModeSelectionError };
        }
        if (creationAuthorizationError) {
          return { ok: false, error: creationAuthorizationError };
        }
        throw error;
      }
      const next = lifecycle.nextEntry;
      const selectedModel = resolveSessionModelRef(cfg, next, target.agentId);
      const resolved = {
        modelProvider: selectedModel.provider,
        model: selectedModel.model,
      };
      // Runtime model identity is a response projection, not reset persistence. Keep the
      // established RPC entry shape while the stored row retains selection intent only.
      const responseEntry: SessionEntry = {
        ...projectPublicSessionEntry(next),
        modelProvider: resolved.modelProvider,
        model: resolved.model,
      };
      return {
        ok: true,
        key: target.canonicalKey,
        entry: responseEntry,
        resolved,
        agentId: target.agentId,
        storePath,
      };
    },
    finalize: async () => {
      if (!lifecyclePreparationCommitted) {
        await rollbackGatewaySessionPreparation({
          prepared: preparedLifecycle,
          onError: reportLifecycleCleanupError,
        });
      }
    },
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
