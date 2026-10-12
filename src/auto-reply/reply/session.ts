import crypto from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { retireSessionMcpRuntime } from "../../agents/agent-bundle-mcp-tools.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { clearBootstrapSnapshotOnSessionBoundary } from "../../agents/bootstrap-cache.js";
import { clearAllCliSessions } from "../../agents/cli-session.js";
import { resetRegisteredAgentHarnessSessions } from "../../agents/harness/registry.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../browser-lifecycle-cleanup.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveSessionParentSessionKey } from "../../channels/plugins/session-conversation.js";
import { conversationRouteContextFromMsgContext } from "../../config/sessions/conversation-route-context.js";
import { hasProviderOwnedSession } from "../../config/sessions/entry-freshness.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import { resolveSessionLifecycleTimestampsAsync } from "../../config/sessions/lifecycle-read.js";
import {
  hasTerminalMainSessionTranscriptNewerThanRegistrySync,
  isRestartRecoveryTombstone,
  resolveSessionWorkStartError,
} from "../../config/sessions/lifecycle.js";
import { deriveSessionMetaPatch } from "../../config/sessions/metadata.js";
import {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveThreadFlag,
  type SessionFreshness,
} from "../../config/sessions/reset.js";
import {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
} from "../../config/sessions/session-accessor.js";
import { sessionEntryForkedFromParent } from "../../config/sessions/session-entry-lineage.js";
import { buildSessionCreationStamp } from "../../config/sessions/session-entry-provenance.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { selectSessionModelOverride } from "../../config/sessions/session-entry-selection.js";
import { resolveMaintenanceConfigFromInput } from "../../config/sessions/store-maintenance.js";
import { runExclusiveSessionStoreWrite } from "../../config/sessions/store-writer.js";
import {
  isRecoverableTerminalSessionStatus,
  recoverTerminalSessionEntryForVisibleTurn,
} from "../../config/sessions/terminal-status.js";
import {
  DEFAULT_RESET_TRIGGERS,
  SESSION_TOTAL_TOKENS_VERSION,
  type SessionEntry,
} from "../../config/sessions/types.js";
import {
  forgetActiveSessionForShutdown,
  noteActiveSessionForShutdown,
} from "../../gateway/active-sessions-shutdown-tracker.js";
import {
  captureSessionMemoryTranscript,
  type SessionMemoryTranscript,
} from "../../hooks/bundled/session-memory/capture.js";
import { hasInternalHookListeners } from "../../hooks/internal-hooks.js";
import { emitSessionAutoResetHook } from "../../hooks/session-auto-reset.js";
import { isDiagnosticFlagEnabled } from "../../infra/diagnostic-flags.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import {
  buildAgentMainSessionKey,
  isAcpSessionKey,
  normalizeMainKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import { resolveAgentHarnessSessionContextError } from "../../sessions/agent-harness-session-key.js";
import { isInterSessionInputProvenance } from "../../sessions/input-provenance.js";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_RESET_MESSAGE,
  ModelSelectionLockedError,
} from "../../sessions/model-overrides.js";
import { recordSessionCreated } from "../../sessions/session-created.js";
import {
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { recordAcceptedSessionParticipantInput } from "../../sessions/session-participant-input-recording.js";
import { prepareChannelParticipantObservation } from "../../sessions/session-participant-input.js";
import {
  classifySessionStateActor,
  registerMainSessionGroupWatch,
} from "../../sessions/session-state-events.js";
import { assertPreparedSkillLibrarySelection } from "../../skills/library/selection.js";
import {
  deliveryContextFromSession,
  sessionDeliveryOrigin,
  sessionDeliveryRoute,
} from "../../utils/delivery-context.read.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type { FinalizedTemplateContext as TemplateContext } from "../templating.js";
import { resolveEffectiveResetTargetSessionKey } from "./acp-reset-target.js";
import { readBeforeResetMessages } from "./commands-reset-hooks.js";
import { normalizeInboundTextNewlines } from "./inbound-text.js";
import { replyRunRegistry } from "./reply-run-registry.js";
import { acknowledgeReplySessionTransition } from "./reply-run-registry.state.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";
import {
  assertPreparedConversationBindingRouteCurrent,
  resolveSessionDefaultAccountId,
  resolveBoundAcpSessionForCommandReset,
} from "./session-conversation-binding.js";
import {
  maybeRetireLegacyMainDeliveryRoute,
  resolveSessionDeliveryRoute,
} from "./session-delivery.js";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";
import {
  createReplySessionResetBoundary,
  emitReplySessionEndHook,
  emitReplySessionStartHook,
  resolveExplicitSessionEndReason,
} from "./session-hooks.js";
import {
  ReplySessionInitConflictError,
  runWithSessionInitConflictRetry,
} from "./session-init-conflict-retry.js";
import type { SessionInitResult } from "./session-init.types.js";
import {
  prepareReplySessionInitialization,
  resolveInitSessionStateAttemptContext,
  resolveInitializationSessionReader,
  type InitSessionStateParams,
  type InitSessionStateAttemptContext,
} from "./session-initialization-admission.js";
import {
  canReplaceRestartTombstoneFromParent,
  prepareReplySessionParentFork,
} from "./session-parent-fork-prepare.js";
import {
  clearCommittedSessionResetRuntimeState,
  createSessionResetCleanupGuard,
  stopSessionResetSubagents,
} from "./session-reset-cleanup.js";
import { resolveAuthorizedSessionResetCommand } from "./session-reset-command.js";
import { resolveReplySessionRolloverState } from "./session-rollover-state.js";
import { withoutThreadDelivery } from "./session-route-reset.js";

const log = createSubsystemLogger("session-init");

type InitSessionLifecycleMutation = {
  kind: "lifecycle-mutation";
  sessionId: string;
  sessionKey: string;
  lifecycleRevision?: string;
  resetTriggered: boolean;
};
type InitSessionStateAttemptOutcome =
  | { kind: "complete"; result: SessionInitResult }
  | InitSessionLifecycleMutation;

type ReplySessionPreprocessingState = {
  sessionEntry?: SessionEntry;
  sessionKey: string;
  storePath: string;
};

/** Resolves durable ownership before utility preprocessing can invoke another model. */
export async function resolveReplySessionPreprocessingState(
  params: Pick<InitSessionStateParams, "cfg" | "ctx">,
): Promise<ReplySessionPreprocessingState> {
  const attemptContext = await resolveInitSessionStateAttemptContext(params, "preprocessing");
  const { sessionKey } = attemptContext;
  const { currentEntry: sessionEntry } = await loadReplySessionInitializationSnapshot({
    agentId: attemptContext.agentId,
    storePath: attemptContext.storePath,
    sessionKey,
  });
  const contextError = resolveAgentHarnessSessionContextError(sessionKey, sessionEntry);
  if (contextError) {
    throw new Error(contextError);
  }
  return {
    sessionEntry,
    sessionKey,
    storePath: attemptContext.storePath,
  };
}

export async function initSessionState(params: InitSessionStateParams): Promise<SessionInitResult> {
  prepareChannelParticipantObservation(params.ctx);
  return await runWithSessionInitConflictRetry(async () => await initSessionStateAttempt(params), {
    signal: params.signal,
  });
}

async function initSessionStateAttempt(params: InitSessionStateParams): Promise<SessionInitResult> {
  const attemptContext = await measureDiagnosticsTimelineSpan("reply.session.binding", () =>
    resolveInitSessionStateAttemptContext(params, "initialization"),
  );
  params.signal?.throwIfAborted();
  const binding = attemptContext.conversationBinding;
  if (binding) {
    await getSessionBindingService().touchAsync(binding.bindingId, undefined, binding.conversation);
    await assertPreparedConversationBindingRouteCurrent(params.ctx);
  }
  params.signal?.throwIfAborted();
  const parentSessionKey = await measureDiagnosticsTimelineSpan("reply.session.hydrate", () =>
    prepareReplySessionInitialization(params, attemptContext),
  );
  // Parent forks and legacy-main retirement can touch other sessions.
  const storeWriterIdentity =
    !parentSessionKey &&
    ((params.cfg.session?.dmScope ?? "main") === "main" || !attemptContext.inputDeliveryKey)
      ? attemptContext.sessionKey
      : undefined;
  // Guarded revision checks only serialize correctly when the snapshot and
  // commit share the same writer lane.
  const runLockedAttempt = (
    lifecycleMutationIdentity?: InitSessionLifecycleMutation,
    writerIdentity?: string,
  ) =>
    measureDiagnosticsTimelineSpan("reply.session.writer", () =>
      runExclusiveSessionStoreWrite(
        attemptContext.storePath,
        async () =>
          await measureDiagnosticsTimelineSpan("reply.session.initialize", () =>
            initSessionStateAttemptLocked(params, attemptContext, lifecycleMutationIdentity),
          ),
        { identities: writerIdentity ? [writerIdentity] : undefined },
      ),
    );
  let rollover = await runLockedAttempt(undefined, storeWriterIdentity);
  while (rollover.kind !== "complete") {
    const candidate = rollover;
    const identities = [candidate.sessionKey, candidate.sessionId];
    let preparedOutcome: InitSessionStateAttemptOutcome | undefined;
    // Drain foreign owners before the rollover takes the writer lane. Holding
    // that lane while waiting would deadlock owners that release after a write.
    rollover = await runExclusiveSessionLifecycleMutation("rollover", {
      scope: attemptContext.storePath,
      identities,
      signal: params.signal,
      prepare: async () => {
        // Cancellation affects live work; do not drain a replacement session
        // selected while this rollover waited for its lifecycle turn.
        const currentEntry = await readSessionEntryReadOnlyInWorker({
          agentId: attemptContext.agentId,
          storePath: attemptContext.storePath,
          sessionKey: candidate.sessionKey,
        });
        if (
          currentEntry?.sessionId !== candidate.sessionId ||
          currentEntry.lifecycleRevision !== candidate.lifecycleRevision
        ) {
          preparedOutcome = await runLockedAttempt();
          return;
        }
        const drained = await interruptSessionWorkAdmissions({
          scope: attemptContext.storePath,
          identities,
          timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
        });
        if (!drained) {
          throw new Error(
            `timed out draining work before reply session rollover: ${candidate.sessionKey}`,
          );
        }
        if (candidate.resetTriggered) {
          // Child cancellation is an effect: resolve its current parent before
          // selecting children, without an additional pre-drain preparation.
          const current = await runLockedAttempt();
          if (
            current.kind === "complete" ||
            current.sessionId !== candidate.sessionId ||
            current.lifecycleRevision !== candidate.lifecycleRevision
          ) {
            preparedOutcome = current;
            return;
          }
          // Child finalizers may need the same store writer. Drain them here,
          // outside that lane, before an explicit reset can commit or run its tail.
          await stopSessionResetSubagents({
            cfg: params.cfg,
            sessionKey: candidate.sessionKey,
            agentId: attemptContext.agentId,
            assertCurrent: createSessionResetCleanupGuard({
              sessionKey: candidate.sessionKey,
              storePath: attemptContext.storePath,
              expectedSession: current,
              assertCurrent: () => params.signal?.throwIfAborted(),
            }),
          });
        }
      },
      // Check the current identity once at the commit instead of rebuilding the
      // complete initialization before and after draining.
      run: async () => preparedOutcome ?? runLockedAttempt(candidate),
    });
  }
  return rollover.result;
}

async function initSessionStateAttemptLocked(
  params: InitSessionStateParams,
  attemptContext: InitSessionStateAttemptContext,
  lifecycleMutationIdentity: InitSessionLifecycleMutation | undefined,
): Promise<InitSessionStateAttemptOutcome> {
  const { ctx, cfg, commandAuthorized } = params;
  const {
    agentId,
    conversationBindingContext,
    isSystemEvent,
    retargetedSession,
    sessionKey,
    sessionCtxForState,
    storePath,
  } = attemptContext;
  const sessionTarget = { agentId, sessionKey, storePath };
  const sessionCfg = cfg.session;
  const maintenanceConfig = resolveMaintenanceConfigFromInput(sessionCfg?.maintenance);
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  const groupResolution = resolveGroupSessionKey(sessionCtxForState) ?? undefined;
  const sessionScope = sessionCfg?.scope ?? "per-sender";
  const ingressTimingEnabled = isDiagnosticFlagEnabled("ingress.timing", cfg);

  const normalizedChatType = normalizeChatType(ctx.ChatType);
  const isGroup =
    normalizedChatType != null && normalizedChatType !== "direct" ? true : Boolean(groupResolution);
  const { resetAuthorized, resetCommand } = await resolveAuthorizedSessionResetCommand({
    ctx,
    cfg,
    agentId,
    isGroup,
    commandAuthorized,
  });
  const boundAcpSessionForCommandReset = await resolveBoundAcpSessionForCommandReset({
    cfg,
    ctx: sessionCtxForState,
    bindingContext: conversationBindingContext,
  });
  // Escaped commands initialize under the transport session, but the bound
  // handler owns the reset. Do not rotate or drain that unrelated source first.
  const shouldDeferResetToBoundAcpCommand =
    Boolean(boundAcpSessionForCommandReset) &&
    resetCommand.matchedResetTriggerLower !== undefined &&
    DEFAULT_RESET_TRIGGERS.some(
      (defaultTrigger) =>
        normalizeOptionalLowercaseString(defaultTrigger) === resetCommand.matchedResetTriggerLower,
    );
  const matchedResetTriggerLower = shouldDeferResetToBoundAcpCommand
    ? undefined
    : resetCommand.matchedResetTriggerLower;
  const { softResetMatched, triggerBodyNormalized } = resetCommand;
  const resetTriggered = matchedResetTriggerLower !== undefined;
  const bodyStripped = resetTriggered ? (resetCommand.payload ?? "") : undefined;

  // Settle binding reads before taking the session snapshot.
  const softResetAllowed =
    softResetMatched &&
    resetAuthorized &&
    !isAcpSessionKey(
      (await resolveEffectiveResetTargetSessionKey({
        cfg,
        ...conversationBindingContext,
        commandTargetSessionKey: resolveCommandTurnTargetSessionKey(sessionCtxForState),
        activeSessionKey: sessionKey,
        allowNonAcpBindingSessionKey: false,
        skipConfiguredFallbackWhenActiveSessionNonAcp: false,
      })) ?? "",
    );

  params.signal?.throwIfAborted();
  const sessionStoreLoadStartMs = ingressTimingEnabled ? Date.now() : 0;
  const mainSessionKey = buildAgentMainSessionKey({ agentId, mainKey });
  const relatedSessionKeys = [
    mainSessionKey,
    ctx.ParentSessionKey,
    ctx.ModelParentSessionKey,
    ctx.CommandTargetSessionKey,
    resolveSessionParentSessionKey(sessionKey),
  ].filter((key): key is string => typeof key === "string");
  const initializationSnapshot = await measureDiagnosticsTimelineSpan(
    "reply.session.snapshot",
    () =>
      loadReplySessionInitializationSnapshot(
        { ...sessionTarget, relatedSessionKeys },
        {
          reader: resolveInitializationSessionReader(params, attemptContext),
          includeLifecycle: true,
          assertCurrent: () => params.signal?.throwIfAborted(),
        },
      ),
  );
  if (ingressTimingEnabled) {
    log.info(
      `session-init store-load agent=${agentId} session=${sessionCtxForState.SessionKey ?? "(no-session)"} ` +
        `elapsedMs=${Date.now() - sessionStoreLoadStartMs} path=${storePath}`,
    );
  }
  const retiredLegacyMainDelivery = maybeRetireLegacyMainDeliveryRoute({
    sessionCfg,
    sessionKey,
    legacyMain: initializationSnapshot.readEntry(mainSessionKey),
    agentId,
    mainKey,
    isGroup,
    inputDeliveryKey: attemptContext.inputDeliveryKey,
  });
  const entry = initializationSnapshot.currentEntry;
  const parentSessionKey = normalizeOptionalString(ctx.ParentSessionKey);
  const parentForkSourceEntry =
    parentSessionKey && parentSessionKey !== sessionKey
      ? initializationSnapshot.readEntry(parentSessionKey)
      : undefined;
  const actorType = isSystemEvent
    ? "system"
    : classifySessionStateActor({ inputProvenance: ctx.InputProvenance }).actorType;
  const restartTombstoneReset =
    resetTriggered &&
    isRestartRecoveryTombstone(entry) &&
    entry?.pluginOwnerId === undefined &&
    actorType === "human";
  const restartTombstoneParentFork = canReplaceRestartTombstoneFromParent({
    actorType,
    entry,
    hasParentForkSource: Boolean(parentForkSourceEntry?.sessionId),
    inboundAccessAuthorized: ctx.InboundAccessAuthorized,
    inboundEventKind: ctx.InboundEventKind,
    nativeCommandTarget: resolveCommandTurnTargetSessionKey(ctx),
    sessionKey,
  });
  const archivedSessionError = resolveSessionWorkStartError(sessionKey, entry, {
    allowRestartTombstoneReplacement: restartTombstoneReset || restartTombstoneParentFork,
    providerReviewAcknowledgment: params.providerReviewAcknowledgment,
  });
  if (archivedSessionError) {
    throw new Error(archivedSessionError);
  }
  // Locked model selection is coupled to the current native session id. Reject before
  // lifecycle cleanup so a reset cannot detach the durable harness binding.
  const lockedModelSelection = isModelSelectionLocked(entry);
  if (resetTriggered && lockedModelSelection) {
    throw new ModelSelectionLockedError(MODEL_SELECTION_LOCKED_RESET_MESSAGE);
  }
  const now = Date.now();
  const isThread = resolveThreadFlag({
    sessionKey,
    messageThreadId: ctx.MessageThreadId,
    threadLabel: ctx.ThreadLabel,
    threadStarterBody: ctx.ThreadStarterBody,
    parentSessionKey: ctx.ParentSessionKey,
  });
  const resetType = resolveSessionResetType({ sessionKey, isGroup, isThread });
  const channelReset = resolveChannelResetConfig({
    sessionCfg,
    channel:
      groupResolution?.channel ??
      (ctx.OriginatingChannel as string | undefined) ??
      ctx.Surface ??
      ctx.Provider,
  });
  const resetPolicy = resolveSessionResetPolicy({
    sessionCfg,
    resetType,
    resetOverride: channelReset,
  });
  const canReuseExistingEntry =
    Boolean(entry?.sessionId) &&
    typeof entry?.updatedAt === "number" &&
    Number.isFinite(entry.updatedAt);
  // Gateway admission pins the source session. A conversation or command target owns a
  // different session id, so applying the source constraint there rejects valid routing.
  const expectedExistingSessionId = retargetedSession
    ? undefined
    : params.expectedExistingSessionId?.trim() || undefined;
  if (expectedExistingSessionId && entry?.sessionId !== expectedExistingSessionId) {
    throw new Error(`session rebound for sessionKey: ${sessionKey}`);
  }
  const pinExpectedExistingSession =
    params.pinExpectedExistingSession === true && expectedExistingSessionId !== undefined;
  const requestedSessionId = params.requestedSessionId?.trim() || undefined;
  // Control UI sends sessionId on ordinary sends too, so only the one-shot reconnect
  // resume signal is allowed to suppress configured idle/daily rollover.
  const reconnectResumeRequested =
    params.resumeRequestedSession === true &&
    requestedSessionId !== undefined &&
    entry?.sessionId === requestedSessionId;
  // Implicit expiry must preserve the same identity for model-locked native sessions too.
  const skipImplicitExpiry =
    lockedModelSelection || (hasProviderOwnedSession(entry) && resetPolicy.configured !== true);
  const lifecycleTimestamps =
    initializationSnapshot.lifecycleTimestamps ??
    (await resolveSessionLifecycleTimestampsAsync({
      entry,
      ...sessionTarget,
      signal: params.signal,
    }));
  const entryFreshness = entry
    ? skipImplicitExpiry
      ? ({ fresh: true } satisfies SessionFreshness)
      : evaluateSessionFreshness({
          updatedAt: entry.updatedAt,
          sessionStartedAt: lifecycleTimestamps.sessionStartedAt,
          lastInteractionAt: lifecycleTimestamps.lastInteractionAt,
          now,
          policy: resetPolicy,
        })
    : undefined;
  const terminalMainTranscriptNewerThanRegistry =
    !isSystemEvent &&
    hasTerminalMainSessionTranscriptNewerThanRegistrySync({
      entry,
      sessionScope,
      ...sessionTarget,
      mainKey,
    });
  const recoverTerminalVisibleEntry =
    canReuseExistingEntry &&
    !isSystemEvent &&
    !resetTriggered &&
    (entryFreshness?.fresh ?? false) &&
    isRecoverableTerminalSessionStatus(entry?.status);
  const freshEntry =
    !restartTombstoneParentFork &&
    (((lockedModelSelection || isSystemEvent) && canReuseExistingEntry) ||
      ((((pinExpectedExistingSession || reconnectResumeRequested || softResetAllowed) &&
        canReuseExistingEntry) ||
        (entryFreshness?.fresh ?? false)) &&
        !terminalMainTranscriptNewerThanRegistry));
  const activeReplyOperation = replyRunRegistry.get(sessionKey);
  const deferImplicitRolloverForActiveRun =
    !resetTriggered &&
    !freshEntry &&
    canReuseExistingEntry &&
    entryFreshness?.fresh === false &&
    activeReplyOperation?.phase !== "queued" &&
    activeReplyOperation?.sessionId === entry?.sessionId;
  // An implicit reset must not append a boundary or interrupt this exact active writer.
  // A bare stale result is the legacy updatedAt=0 pending-reset tombstone.
  const effectiveFreshEntry = deferImplicitRolloverForActiveRun || freshEntry;
  // Keep the owed reset pending until the active writer completes.
  const retainPendingResetMarker = deferImplicitRolloverForActiveRun && entry?.updatedAt === 0;
  // Explicit and scheduled resets both retain the prior entry for lifecycle hooks.
  const previousSessionEntry =
    (resetTriggered || !effectiveFreshEntry) && entry ? { ...entry } : undefined;
  const previousSessionEndReason = resetTriggered
    ? resolveExplicitSessionEndReason(matchedResetTriggerLower)
    : entryFreshness?.staleReason;
  const lifecycleMutationMatches = Boolean(
    previousSessionEntry &&
    lifecycleMutationIdentity?.sessionKey === sessionKey &&
    lifecycleMutationIdentity.sessionId === previousSessionEntry.sessionId &&
    lifecycleMutationIdentity.lifecycleRevision === previousSessionEntry.lifecycleRevision,
  );
  if (previousSessionEntry && !lifecycleMutationMatches) {
    return {
      kind: "lifecycle-mutation",
      sessionId: previousSessionEntry.sessionId,
      sessionKey,
      lifecycleRevision: previousSessionEntry.lifecycleRevision,
      resetTriggered,
    };
  }
  const recoveredTerminalEntry =
    entry && recoverTerminalVisibleEntry
      ? recoverTerminalSessionEntryForVisibleTurn(entry)
      : undefined;
  const baseEntry =
    !resetTriggered && effectiveFreshEntry && canReuseExistingEntry
      ? (recoveredTerminalEntry ?? entry)
      : undefined;
  const isNewSession = !baseEntry;
  const systemSent = baseEntry?.systemSent ?? false;
  const abortedLastRun = baseEntry?.abortedLastRun ?? false;
  // Durable resets retain their transcript identity for cursor continuity; ACP
  // resets still rotate the local session id that owns provider conversation state.
  let sessionId =
    baseEntry?.sessionId ??
    (isAcpSessionKey(sessionKey) || restartTombstoneParentFork
      ? crypto.randomUUID()
      : (entry?.sessionId ?? crypto.randomUUID()));
  // Explicit and implicit resets preserve user selections; automatic fallback
  // overrides are filtered by resolveResetPreservedSelection.
  const preservedState: Partial<SessionEntry> | undefined = baseEntry
    ? selectSessionModelOverride(baseEntry)
    : entry
      ? resolveReplySessionRolloverState(entry, sessionKey)
      : undefined;
  // Implicit rollover keeps the worker workspace; explicit resets keep their detachment policy.
  if (isNewSession && !resetTriggered && entry && preservedState) {
    if (entry.worktree) {
      preservedState.worktree = entry.worktree;
    }
    if (entry.repositoryWorkspaceId) {
      preservedState.repositoryWorkspaceId = entry.repositoryWorkspaceId;
    }
  }

  const usageFamilyKey = previousSessionEntry
    ? (previousSessionEntry.usageFamilyKey ?? sessionKey)
    : baseEntry?.usageFamilyKey;
  const usageFamilySessionIds = previousSessionEntry
    ? Array.from(
        new Set([
          ...(previousSessionEntry.usageFamilySessionIds ?? []),
          previousSessionEntry.sessionId,
          sessionId,
        ]),
      )
    : baseEntry?.usageFamilySessionIds;
  const originatingChannelRaw = ctx.OriginatingChannel as string | undefined;
  const isInterSession = isInterSessionInputProvenance(ctx.InputProvenance);
  // Automated turns must not replace the conversation's external delivery route.
  let deliveryContext = deliveryContextFromSession(baseEntry);
  const baseDeliveryOrigin = sessionDeliveryOrigin(baseEntry);
  if (!isSystemEvent) {
    const { channel, to } = resolveSessionDeliveryRoute({
      originatingChannelRaw,
      originatingToRaw: ctx.OriginatingTo,
      toRaw: ctx.To,
      persistedLastTo: deliveryContext?.to,
      persistedLastChannel: deliveryContext?.channel,
      sessionKey,
      isInterSession,
    });
    // Internal turns retain the external thread; external non-thread turns clear stale routing.
    const preservePersistedThread = isThread || isInternalMessageChannel(originatingChannelRaw);
    deliveryContext = {
      channel,
      to,
      accountId: resolveSessionDefaultAccountId({
        cfg,
        channelRaw: channel,
        accountIdRaw: ctx.AccountId,
        persistedLastAccountId: deliveryContext?.accountId,
      }),
      threadId:
        ctx.MessageThreadId ??
        ctx.TransportThreadId ??
        (preservePersistedThread ? deliveryContext?.threadId : undefined),
    };
  }
  const delivery =
    isSystemEvent && !isThread
      ? withoutThreadDelivery(baseEntry)
      : normalizeSessionDeliveryState({
          route: isSystemEvent ? sessionDeliveryRoute(baseEntry) : undefined,
          context: deliveryContext,
          origin: baseDeliveryOrigin,
        });
  const creationStamp =
    !entry && ctx.SessionCreation ? buildSessionCreationStamp(ctx.SessionCreation) : undefined;
  let sessionEntry: SessionEntry = {
    ...baseEntry,
    ...preservedState,
    ...creationStamp,
    sessionId,
    lifecycleRevision: isNewSession ? crypto.randomUUID() : baseEntry?.lifecycleRevision,
    updatedAt: retainPendingResetMarker ? 0 : Date.now(),
    sessionStartedAt: isNewSession
      ? now
      : (baseEntry?.sessionStartedAt ?? lifecycleTimestamps.sessionStartedAt),
    lastInteractionAt: isSystemEvent ? baseEntry?.lastInteractionAt : now,
    agentStatus: isSystemEvent ? baseEntry?.agentStatus : undefined,
    pinnedAt: entry?.pinnedAt,
    snoozedUntil: isSystemEvent ? entry?.snoozedUntil : undefined,
    snoozedAt: isSystemEvent ? entry?.snoozedAt : undefined,
    systemSent,
    abortedLastRun: recoveredTerminalEntry ? recoveredTerminalEntry.abortedLastRun : abortedLastRun,
    usageFamilyKey,
    usageFamilySessionIds,
    delivery,
    groupActivation: entry?.groupActivation,
    groupActivationNeedsSystemIntro: entry?.groupActivationNeedsSystemIntro,
  };
  const metaPatch = deriveSessionMetaPatch({
    ctx: sessionCtxForState,
    sessionKey,
    existing: sessionEntry,
    groupResolution,
    skipSystemEventOrigin: isSystemEvent,
  });
  if (metaPatch) {
    sessionEntry = { ...sessionEntry, ...metaPatch };
  }
  if (!sessionEntry.chatType) {
    sessionEntry.chatType = "direct";
  }
  const threadLabel = normalizeOptionalString(ctx.ThreadLabel);
  // Derived labels initialize titles; channel renames and generated titles own later changes.
  if (threadLabel && !sessionEntry.displayName) {
    sessionEntry.displayName = threadLabel;
  }
  const alreadyForked = sessionEntryForkedFromParent(sessionEntry);
  if (params.signal?.aborted === true) {
    throw new Error("reply session initialization aborted");
  }
  if (isNewSession) {
    sessionEntry.compactionCount = 0;
    sessionEntry.memoryFlush = undefined;
    // Runtime model fields are persisted last-run cache, not user selection.
    // Reset must drop them so the next turn resolves current defaults or the
    // explicit providerOverride/modelOverride values preserved above.
    sessionEntry.modelProvider = undefined;
    sessionEntry.model = undefined;
    sessionEntry.fallbackNotice = undefined;
    sessionEntry.systemPromptReport = undefined;
    sessionEntry.startedAt = undefined;
    sessionEntry.endedAt = undefined;
    sessionEntry.runtimeMs = undefined;
    sessionEntry.status = undefined;
    // New empty transcripts have a known zero context. Parent-context forks
    // inherit history without a fresh count, so keep those explicitly unknown.
    sessionEntry.totalTokens = 0;
    sessionEntry.totalTokensFresh = true;
    sessionEntry.totalTokensVersion = SESSION_TOTAL_TOKENS_VERSION;
    sessionEntry.inputTokens = undefined;
    sessionEntry.outputTokens = undefined;
    sessionEntry.estimatedCostUsd = undefined;
    sessionEntry.cacheRead = undefined;
    sessionEntry.cacheWrite = undefined;
    sessionEntry.contextTokens = undefined;
    sessionEntry.contextTokensSource = undefined;
    sessionEntry.contextBudgetStatus = undefined;
    sessionEntry.goal = undefined;
    // Skills snapshots are prompt/runtime caches. Do not preserve a stale
    // snapshot through /new; the next turn must rebuild the visible skill list.
    sessionEntry.skillsSnapshot = undefined;
  }
  const resetBoundary = previousSessionEntry
    ? createReplySessionResetBoundary({
        cwd: resolveAgentWorkspaceDir(cfg, agentId),
        explicitReason: resolveExplicitSessionEndReason(matchedResetTriggerLower),
        previousReason: previousSessionEndReason,
        resetTriggered,
      })
    : undefined;
  let previousSessionMemory: SessionMemoryTranscript | undefined;
  let previousSessionResetMessages: unknown[] | undefined;
  const committed = await measureDiagnosticsTimelineSpan("reply.session.commit", () =>
    commitReplySessionInitialization({
      bindCreation: params.bindSessionCreation,
      ...sessionTarget,
      commitGuard: !entry
        ? () => {
            params.signal?.throwIfAborted();
            assertPreparedSkillLibrarySelection(ctx.SessionCreation?.skillLibrarySelections);
          }
        : undefined,
      activeSessionKey: sessionKey,
      expectedRevision: initializationSnapshot.revision,
      relatedSessionKeys,
      maintenanceConfig,
      prepareSessionEntry: async ({ readEntry, sessionEntry: entryToCommit }) => {
        if (params.signal?.aborted === true) {
          throw new Error("reply session initialization aborted");
        }
        return await prepareReplySessionParentFork({
          ...sessionTarget,
          alreadyForked,
          parentSessionKey,
          requireParentForkReplacement: restartTombstoneParentFork,
          readEntry,
          sessionEntry: entryToCommit,
          warn: (message) => log.warn(message),
        });
      },
      ...(resetBoundary ? { resetBoundary } : {}),
      beforeEntryMutation: async ({ currentEntry, sessionEntry: entryToCommit }) => {
        if (!previousSessionEntry || !currentEntry) {
          return;
        }
        await resetRegisteredAgentHarnessSessions({
          agentId,
          sessionId: currentEntry.sessionId,
          sessionKey,
          sessionFile: sessionKey,
          reason: previousSessionEndReason ?? "unknown",
        });
        const memoryEvent = resetTriggered ? "command" : "session";
        const memoryAction = resetTriggered ? (previousSessionEndReason ?? "new") : "auto-reset";
        if (hasInternalHookListeners(memoryEvent, memoryAction)) {
          // Capture before the same-identity reset changes the visible window.
          // Only the successful lifecycle commit publishes this bounded snapshot.
          previousSessionMemory = await captureSessionMemoryTranscript(
            {
              ...sessionTarget,
              sessionId: currentEntry.sessionId,
            },
            cfg,
          );
        }
        if (resetTriggered && getGlobalHookRunner()?.hasHooks("before_reset")) {
          // Plugin observers retain their full-message contract independently of
          // the bounded memory excerpt. This preparation runs outside the commit.
          previousSessionResetMessages = await readBeforeResetMessages({
            ...sessionTarget,
            sessionId: currentEntry.sessionId,
          });
        }
        if (resetBoundary) {
          clearAllCliSessions(entryToCommit);
          entryToCommit.agentHarnessId = undefined;
        }
      },
      previousEntry: previousSessionEntry,
      ...(!isSystemEvent &&
      sessionCtxForState.InboundAccessAuthorized === true &&
      sessionCtxForState.ConversationRouteContextObserved === true
        ? { routeContext: conversationRouteContextFromMsgContext(sessionCtxForState) ?? null }
        : {}),
      retiredEntry: retiredLegacyMainDelivery,
      sessionEntry,
      snapshotEntry: initializationSnapshot.currentEntry,
    }),
  );
  if (!committed.ok) {
    // The outer retry owns conflicts; never retry while holding the writer lane.
    throw new ReplySessionInitConflictError(sessionKey);
  }
  if (
    params.replyOperation?.key === sessionKey &&
    (entry?.sessionId !== committed.sessionEntry.sessionId ||
      entry?.lifecycleRevision !== committed.sessionEntry.lifecycleRevision)
  ) {
    await acknowledgeReplySessionTransition(params.replyOperation, {
      previous: entry,
      current: committed.sessionEntry,
    });
  }
  clearCommittedSessionResetRuntimeState({
    previousSessionEntry,
    agentId,
    sessionKey,
    signal: params.signal,
    onError: (error) =>
      log.warn(`failed to clear reset runtime state for session ${sessionKey}: ${String(error)}`),
  });
  sessionEntry = committed.sessionEntry;
  sessionId = sessionEntry.sessionId;
  // Admission may commit the first row before dispatch. Preserve its Goal and generation
  // through initialization, then report the first lifecycle only for that winning dispatch.
  const createdByAdmission =
    pinExpectedExistingSession &&
    params.newlyCreatedSessionId === sessionId &&
    !previousSessionEntry;
  const isFirstSessionTurn = isNewSession || createdByAdmission;
  if (!isSystemEvent && !isInterSession) {
    recordAcceptedSessionParticipantInput(ctx, {
      ...sessionTarget,
      onError: (error) => log.warn("failed to record session participant", { error }),
    });
  }
  clearBootstrapSnapshotOnSessionBoundary({
    boundaryAppended: resetBoundary !== undefined,
    sessionKey,
  });
  if (!entry) {
    await recordSessionCreated(cfg, { sessionKey, agentId, entry: sessionEntry });
  }
  await registerMainSessionGroupWatch({
    sessionKey,
    agentId,
    entry: sessionEntry,
    mainKey,
    isSystemEvent,
    inputProvenance: ctx.InputProvenance,
    signal: params.signal,
  });
  params.signal?.throwIfAborted();
  const sessionStore = committed.sessionStoreView;
  const sessionEntryHandle = createReplySessionEntryHandle({
    sessionEntry,
    sessionKey,
    sessionStore,
  });
  if (previousSessionEntry?.sessionId) {
    emitSessionAutoResetHook({
      ...sessionTarget,
      cfg,
      sessionId: previousSessionEntry.sessionId,
      reason: previousSessionEndReason,
      nextSessionId: sessionId,
      nextSessionKey: sessionKey,
      workspaceDir: previousSessionEntry.spawnedWorkspaceDir,
      previousSessionMemory,
    });
    await retireSessionMcpRuntime({
      sessionId: previousSessionEntry.sessionId,
      reason: "reply-session-rollover",
      onError: (error, sessionIdLocal) => {
        log.warn(`failed to dispose bundle MCP runtime for session ${sessionIdLocal}`, {
          error: String(error),
        });
      },
    });
    // Direct-message browser tabs use a peer-scoped runtime identity even when
    // their transcript aliases main; cleanup must carry both exact keys.
    const runtimePolicySessionKey =
      resolveRuntimePolicySessionKey({
        agentId,
        cfg,
        ctx: sessionCtxForState,
        sessionKey,
      }) ?? sessionKey;
    void runWithGatewayIndependentRootWorkContinuation(async () => {
      await cleanupBrowserSessionsForLifecycleEnd({
        cfg,
        sessionKeys: [previousSessionEntry.sessionId, sessionKey, runtimePolicySessionKey].map(
          (requestKey) => toAgentStoreSessionKey({ agentId, requestKey }),
        ),
        onWarn: (message) => log.warn(message),
        onError: (error) => log.warn(`browser tab cleanup failed: ${String(error)}`),
      });
    }, "session:browser-cleanup").catch((error: unknown) => {
      log.warn(`browser tab cleanup admission failed: ${String(error)}`);
    });
  }

  const sessionCtx: TemplateContext = {
    ...sessionCtxForState,
    agentText: normalizeInboundTextNewlines(bodyStripped ?? sessionCtxForState.agentText),
    BodyStripped: normalizeInboundTextNewlines(bodyStripped ?? sessionCtxForState.agentText),
    SessionId: sessionId,
    IsNewSession: isFirstSessionTurn ? "true" : "false",
  };

  const hookRunner = getGlobalHookRunner();
  if (hookRunner && isFirstSessionTurn) {
    if (previousSessionEntry?.sessionId) {
      // The shutdown finalizer must not re-fire session_end for a session
      // that is being replaced here; forget unconditionally so the next drain
      // skips this id even when no `session_end` plugin is currently attached.
      forgetActiveSessionForShutdown(previousSessionEntry.sessionId);
      if (hookRunner.hasHooks("session_end")) {
        emitReplySessionEndHook({
          ...sessionTarget,
          hookRunner,
          sessionId: previousSessionEntry.sessionId,
          reason: previousSessionEndReason,
          nextSessionId: sessionId,
          resetBoundaryId: resetBoundary?.boundaryId,
        });
      }
    }

    if (sessionId) {
      // Track the new session so the shutdown finalizer fires a typed
      // session_end with reason="shutdown"/"restart" if the gateway stops
      // while this session is still active (see #57790).
      noteActiveSessionForShutdown({
        ...sessionTarget,
        cfg,
        sessionId,
        sessionFile: sessionKey,
      });
    }
    if (hookRunner.hasHooks("session_start")) {
      emitReplySessionStartHook(hookRunner, {
        sessionId,
        sessionKey,
        agentId,
        resumedFrom: previousSessionEntry?.sessionId,
      });
    }
  }

  return {
    kind: "complete",
    result: {
      sessionCtx,
      sessionEntry,
      sessionEntryHandle,
      previousSessionEntry,
      sessionStore,
      previousSessionMemory,
      previousSessionResetMessages,
      sessionKey,
      sessionId,
      isNewSession: isFirstSessionTurn,
      resetTriggered,
      systemSent,
      abortedLastRun,
      storePath,
      sessionScope,
      groupResolution,
      isGroup,
      bodyStripped,
      triggerBodyNormalized,
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
