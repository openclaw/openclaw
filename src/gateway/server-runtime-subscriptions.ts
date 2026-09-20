// Gateway event subscription wiring for agent, heartbeat, transcript, and lifecycle broadcasts.
import { isDefinitiveRunLifecycle } from "../agents/agent-run-terminal-outcome.js";
import {
  isAuditLedgerEnabled,
  isExecutionIdentityCollectionEnabled,
  resolveAuditMessageMode,
} from "../audit/audit-config.js";
import { createAuditEventRecorder } from "../audit/audit-recorder.js";
import { configureExecutionDecisionWorkSink } from "../audit/execution-decision-work.js";
import { configureExecutionIdentityAdmissionSink } from "../audit/execution-identity-admission.js";
import { configureMessageActionDecisionSink } from "../audit/message-action-decision.js";
import { onTrustedMessageAuditEvent } from "../audit/message-audit-events.js";
import { configureRuntimeActionDecisionSink } from "../audit/runtime-action-decision.js";
import {
  configureChannelAdmissionDecisionSink,
  configureChannelAdmissionEvidenceCollection,
} from "../channels/message-access/admission-evidence.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  type AgentEventRuntimePayload,
  onAgentAuditEvent,
  onAgentRuntimeEvent,
} from "../infra/agent-events.js";
import { clearAgentRunContext, getAgentRunContext } from "../infra/agent-run-registry.js";
import { captureAgentRunTerminalWriteContext } from "../infra/agent-run-terminal-writes.js";
import { onTrustedToolExecutionEvent } from "../infra/diagnostic-events.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import {
  onGatewaySuspendAdmissionChange,
  runWithRetainedGatewayRootWork,
} from "../process/gateway-work-admission.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { createLazyPromise, createLazyPromiseLoader } from "../shared/lazy-runtime.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { markChatAbortTerminalPersistenceError } from "./chat-abort-lifecycle-internal.js";
import {
  type ChatAbortControllerEntry,
  removeChatAbortControllerEntry,
  type RestartRecoveryCandidate,
} from "./chat-abort.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import type {
  ChatRunState,
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
  ToolEventRecipientRegistry,
} from "./server-chat-state.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import { startGatewayTaskSubscriptions } from "./server-task-subscriptions.js";
import { createSessionActivitySummaries } from "./session-activity-summaries.js";
import { defaultSessionCompanionContextReader } from "./session-companion-context.js";
import { createSessionCompanion } from "./session-companion.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import { createSessionLifecyclePersistenceOwner } from "./session-lifecycle-persistence-owner.js";
import { sessionObserverScopeKey } from "./session-observer-model.js";
import { createSessionObserver } from "./session-observer.js";
import {
  tryResolveSessionCompatibilityOwnerAgentId,
  resolveSessionEventAgentScope,
} from "./session-request-agent.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import type { TerminalSessionManager } from "./terminal/session-manager.js";

function dispatchEventHandler<TEvent>(params: {
  loadHandler: () => Promise<(event: TEvent) => unknown>;
  event: TEvent;
  log: SubsystemLogger;
  failureMessage: string;
  context: Record<string, unknown>;
  onFailure?: () => void;
}) {
  return runWithRetainedGatewayRootWork(() =>
    params
      .loadHandler()
      .then((handler) => handler(params.event))
      .then(() => undefined)
      .catch((error: unknown) => {
        params.log.warn(params.failureMessage, { ...params.context, error });
        params.onFailure?.();
      }),
  );
}

/** Register gateway runtime event subscriptions and return unsubscribe handles. */
export function startGatewayEventSubscriptions(params: {
  signal: AbortSignal;
  log: SubsystemLogger;
  broadcast: GatewayBroadcastFn;
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  nodeHasSessionSubscribers: (sessionKey: string) => boolean;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  toolEventRecipients: ToolEventRecipientRegistry;
  sessionEventSubscribers: SessionEventSubscriberRegistry;
  sessionMessageSubscribers: SessionMessageSubscriberRegistry;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  restartRecoveryCandidates: Map<string, RestartRecoveryCandidate>;
  terminalSessions: Pick<TerminalSessionManager, "closeTaskSessions">;
  refreshConnectedUserProfiles: () => void;
  getSessionRowProjection?: () => SessionRowProjection | undefined;
}) {
  // The worker always runs retention maintenance. audit.enabled only controls
  // producer subscriptions, so disabling collection cannot strand expired rows.
  const runtimeConfig = getRuntimeConfig();
  const auditEnabled = isAuditLedgerEnabled(runtimeConfig);
  const auditMessageMode = resolveAuditMessageMode(runtimeConfig);
  const auditRecorder = createAuditEventRecorder({
    messageMode: auditEnabled ? auditMessageMode : "off",
  });
  const clearExecutionIdentityAdmissionSink = configureExecutionIdentityAdmissionSink(
    auditRecorder.recordExecutionIdentity,
  );
  const clearExecutionDecisionWorkSink = configureExecutionDecisionWorkSink(
    auditRecorder.recordExecutionDecisionWork,
  );
  const clearChannelAdmissionEvidenceCollection = configureChannelAdmissionEvidenceCollection(
    isExecutionIdentityCollectionEnabled(runtimeConfig),
  );
  const clearChannelAdmissionDecisionSink = configureChannelAdmissionDecisionSink(
    auditRecorder.recordExecutionDecision,
  );
  const clearMessageActionDecisionSink = configureMessageActionDecisionSink(
    auditRecorder.recordExecutionDecision,
  );
  const clearRuntimeActionDecisionSink = configureRuntimeActionDecisionSink(
    auditRecorder.recordExecutionDecision,
  );
  const sessionActivitySummaries = createSessionActivitySummaries({
    getConfig: getRuntimeConfig,
    onChanged: (target) => {
      const publication = (async () => {
        const projection = params.getSessionRowProjection?.();
        const captured = projection?.capture({ key: target.key, agentId: target.agentId });
        if (projection) {
          do {
            await projection.ensureMaterialized();
          } while (projection.needsMaterialization);
        }
        if (projection && (!captured || !projection.isCurrent(captured))) {
          return;
        }
        const row = projection?.snapshot({ key: target.key, agentId: target.agentId }).row;
        params.broadcast(
          "sessions.changed",
          {
            sessionKey: target.key,
            agentId: target.agentId,
            reason: "activity-summary",
            ...buildGatewaySessionSnapshot({
              sessionRow: row,
              agentId: target.agentId,
              includeSession: true,
            }),
          },
          { sessionKeys: [target.key], agentId: target.agentId, dropIfSlow: true },
        );
      })().catch((error: unknown) =>
        params.log.warn("Activity summary publication failed", { error }),
      );
      agentEventDispatches.add(publication);
      void publication.then(() => agentEventDispatches.delete(publication));
    },
  });
  const sessionObserver = createSessionObserver({
    getConfig: getRuntimeConfig,
    subscribers: params.sessionMessageSubscribers,
    sessionEventSubscribers: params.sessionEventSubscribers,
    broadcastToConnIds: params.broadcastToConnIds,
  });
  const sessionCompanion = createSessionCompanion({
    contextReader: defaultSessionCompanionContextReader,
    getConfig: getRuntimeConfig,
    sessionObserver,
  });
  let sessionBackgroundStop: Promise<void> | undefined;
  // Auxiliary model calls can inherit request work; cancel before that work drains.
  const stopSessionBackgroundWork = (): void => {
    if (!sessionBackgroundStop) {
      sessionCompanion.dispose();
      sessionObserver.dispose();
      sessionBackgroundStop = sessionActivitySummaries.dispose();
      void sessionBackgroundStop.catch((error: unknown) => {
        params.log.warn(`session background cleanup failed: ${String(error)}`);
      });
    }
  };
  params.signal.addEventListener("abort", stopSessionBackgroundWork, { once: true });
  if (params.signal.aborted) {
    stopSessionBackgroundWork();
  }
  const unsubscribePrivateAuditEvents = auditEnabled
    ? onAgentAuditEvent(auditRecorder.record)
    : undefined;
  const unsubscribeToolAuditEvents = auditEnabled
    ? onTrustedToolExecutionEvent(auditRecorder.recordTool)
    : undefined;
  const unsubscribeMessageAuditEvents =
    auditEnabled && auditMessageMode !== "off"
      ? onTrustedMessageAuditEvent(auditRecorder.recordMessage)
      : undefined;
  const sessionLifecyclePersistence = createSessionLifecyclePersistenceOwner();
  const agentEventDispatches = new Set<Promise<void>>();
  const eventRowOwners = new WeakMap<
    AgentEventRuntimePayload,
    { projection: SessionRowProjection; record: ReturnType<SessionRowProjection["capture"]> }
  >();
  const trackedRunIds = (runId: string, clientRunId: string) =>
    runId === clientRunId ? [runId] : [runId, clientRunId];
  const clearTrackedActiveRun = (run: { runId: string; clientRunId: string }) => {
    for (const candidateRunId of trackedRunIds(run.runId, run.clientRunId)) {
      const entry = params.chatAbortControllers.get(candidateRunId);
      if (!entry) {
        continue;
      }
      entry.projectSessionActive = false;
      entry.projectSessionTerminalPersisted = false;
      markChatAbortTerminalPersistenceError(entry, undefined);
      queueMicrotask(() => {
        const current = params.chatAbortControllers.get(candidateRunId);
        if (
          current === entry &&
          entry.registrationCleanupRequested === true &&
          !entry.projectSessionTerminalPersistence
        ) {
          removeChatAbortControllerEntry(params.chatAbortControllers, candidateRunId, entry);
        }
      });
    }
  };
  const settleTrackedTerminal = (run: {
    runId: string;
    clientRunId: string;
    persisted?: boolean;
  }) => {
    const persisted = run.persisted ?? true;
    for (const candidateRunId of trackedRunIds(run.runId, run.clientRunId)) {
      const entry = params.chatAbortControllers.get(candidateRunId);
      if (!entry) {
        continue;
      }
      if (persisted) {
        params.restartRecoveryCandidates.delete(candidateRunId);
        markChatAbortTerminalPersistenceError(entry, undefined);
      }
      entry.projectSessionTerminalPending = false;
      entry.projectSessionTerminalPersistence = undefined;
      entry.projectSessionTerminalPersisted = persisted;
      if (entry.registrationCleanupRequested === true) {
        removeChatAbortControllerEntry(params.chatAbortControllers, candidateRunId, entry);
      }
    }
  };
  const trackTrackedRunTerminalPersistence = (run: {
    runId: string;
    clientRunId: string;
    sessionId?: string;
    persistence: Promise<void>;
  }) => {
    let tracked = false;
    for (const candidateRunId of trackedRunIds(run.runId, run.clientRunId)) {
      const entry = params.chatAbortControllers.get(candidateRunId);
      if (!entry) {
        continue;
      }
      tracked = true;
      entry.projectSessionTerminalPersistence = run.persistence;
      void run.persistence.catch((error: unknown) => {
        markChatAbortTerminalPersistenceError(entry, error);
      });
      const lifecycleGeneration = entry.lifecycleGeneration?.trim();
      const sessionKey = entry.sessionKey.trim();
      const sessionId = run.sessionId?.trim() || entry.sessionId.trim();
      // Lazy chat consumption must retain the terminal time stamped at ingress.
      const observedAt = entry.projectSessionTerminalObservedAt;
      if (entry.controlUiVisible !== false && lifecycleGeneration && sessionKey && sessionId) {
        void run.persistence.catch(() => {
          params.restartRecoveryCandidates.set(candidateRunId, {
            runId: candidateRunId,
            lifecycleGeneration,
            sessionKey,
            sessionId,
            observedAt,
          });
        });
      }
    }
    return tracked;
  };
  const getSessionKeyModule = createLazyPromise(() => import("./server-session-key.js"), {
    cacheRejections: true,
  });
  const agentEventHandlerLoader = createLazyPromiseLoader(
    () => {
      // Lazy-load heavy chat modules only after the first agent event reaches the gateway.
      return Promise.all([import("./server-chat.js"), getSessionKeyModule()]).then(
        ([{ createAgentEventHandler }, { resolveSessionKeyForRun }]) =>
          createAgentEventHandler({
            broadcast: params.broadcast,
            broadcastToConnIds: params.broadcastToConnIds,
            nodeHasSessionSubscribers: params.nodeHasSessionSubscribers,
            nodeSendToSession: params.nodeSendToSession,
            agentRunSeq: params.agentRunSeq,
            chatRunState: params.chatRunState,
            resolveSessionKeyForRun,
            clearAgentRunContext,
            toolEventRecipients: params.toolEventRecipients,
            sessionEventSubscribers: params.sessionEventSubscribers,
            sessionMessageSubscribers: params.sessionMessageSubscribers,
            getSessionRowProjection: params.getSessionRowProjection,
            loadGatewaySessionLifecycleSnapshotForEvent: (key, options) => {
              // Tool progress must not wait for optional row enrichment before reply capture.
              if (
                !options?.ownerEvent &&
                params.getSessionRowProjection?.()?.needsMaterialization
              ) {
                return { row: null };
              }
              const owner = options?.ownerEvent
                ? eventRowOwners.get(options.ownerEvent)
                : undefined;
              if (
                options?.ownerEvent &&
                (!owner?.record || !owner.projection.isCurrent(owner.record))
              ) {
                return { row: null };
              }
              const scope = resolveSessionEventAgentScope(
                getRuntimeConfig(),
                key,
                options?.agentId,
              );
              const snapshot = scope?.[1]
                ? (params.getSessionRowProjection?.()?.snapshot({ key, agentId: scope[1] }) ?? {
                    row: null,
                  })
                : { row: null };
              return options?.ownerEvent?.sessionId &&
                snapshot.row?.sessionId !== options.ownerEvent.sessionId
                ? { row: null }
                : snapshot;
            },
            persistGatewaySessionLifecycleEventForEvent: sessionLifecyclePersistence.persist,
            updateRunToolErrorSummary: ({ runId, clientRunId, summary }) => {
              for (const candidateRunId of new Set([runId, clientRunId])) {
                const entry = params.chatAbortControllers.get(candidateRunId);
                if (entry) {
                  entry.toolErrorSummary = summary;
                }
              }
            },
            clearTrackedActiveRun,
            settleTrackedTerminal,
            trackTrackedRunTerminalPersistence,
            isChatSendRunActive: (runId) => {
              const entry = params.chatAbortControllers.get(runId);
              return entry !== undefined && entry.kind !== "agent";
            },
            resolveActiveLifecycleGenerationForRun: (runId) =>
              params.chatAbortControllers.get(runId)?.lifecycleGeneration,
            resolveSessionActiveRunState: (session) =>
              resolveVisibleActiveSessionRunState({
                context: params,
                ...session,
                projectedAgentRunIndex:
                  params.getSessionRowProjection?.()?.state.rowContext.projectedAgentRuns,
                defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(
                  getRuntimeConfig(),
                  session.requestedKey,
                ),
              }),
          }),
      );
    },
    { cacheRejections: true },
  );
  const getAgentEventHandler = agentEventHandlerLoader.load;

  const getSessionEventsModule = createLazyPromise(() => import("./server-session-events.js"), {
    cacheRejections: true,
  });

  let transcriptUpdateHandlerPromise: Promise<
    ReturnType<typeof import("./server-session-events.js").createTranscriptUpdateBroadcastHandler>
  > | null = null;
  const getTranscriptUpdateHandler = () => {
    transcriptUpdateHandlerPromise ??= getSessionEventsModule().then(
      ({ createTranscriptUpdateBroadcastHandler }) =>
        createTranscriptUpdateBroadcastHandler({
          broadcastToConnIds: params.broadcastToConnIds,
          sessionEventSubscribers: params.sessionEventSubscribers,
          sessionMessageSubscribers: params.sessionMessageSubscribers,
          chatAbortControllers: params.chatAbortControllers,
          getSessionRowProjection: params.getSessionRowProjection,
        }),
    );
    return transcriptUpdateHandlerPromise;
  };

  let lifecycleEventHandlerPromise: Promise<
    ReturnType<typeof import("./server-session-events.js").createLifecycleEventBroadcastHandler>
  > | null = null;
  const getLifecycleEventHandler = () => {
    lifecycleEventHandlerPromise ??= getSessionEventsModule().then(
      ({ createLifecycleEventBroadcastHandler }) =>
        createLifecycleEventBroadcastHandler({
          broadcastToConnIds: params.broadcastToConnIds,
          sessionEventSubscribers: params.sessionEventSubscribers,
          chatAbortControllers: params.chatAbortControllers,
          getSessionRowProjection: params.getSessionRowProjection,
        }),
    );
    return lifecycleEventHandlerPromise;
  };

  const unsubscribeAgentEvents = onAgentRuntimeEvent((evt) => {
    if (evt.stream === "lifecycle") {
      const projection = params.getSessionRowProjection?.();
      if (projection) {
        const link = params.chatRunState.registry.peek(evt.runId);
        const run = getAgentRunContext(evt.runId);
        const key = link?.sessionKey ?? evt.deliverySessionKey ?? evt.sessionKey ?? run?.sessionKey;
        const scope = key
          ? resolveSessionEventAgentScope(
              getRuntimeConfig(),
              key,
              link?.agentId ?? evt.agentId ?? run?.agentId,
            )
          : undefined;
        if (key && scope?.[1]) {
          eventRowOwners.set(evt, {
            projection,
            record: projection.capture({ key, agentId: scope[1] }),
          });
        }
      }
    }
    let failedDispatchCleanup: (() => void) | undefined;
    let terminalPreparation: Promise<void> | undefined;
    sessionObserver.handleEvent(evt);
    sessionActivitySummaries.handleEvent(evt);
    if (auditEnabled) {
      auditRecorder.record(evt);
    }
    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string"
        ? evt.data.phase
        : undefined;
    if (lifecyclePhase === "end" || lifecyclePhase === "error") {
      const chatLink = evt.contextClaimId
        ? undefined
        : params.chatRunState.registry.peek(evt.runId);
      const clientRunId = chatLink?.clientRunId ?? evt.runId;
      const candidateRunIds = evt.runId === clientRunId ? [evt.runId] : [evt.runId, clientRunId];
      const observedAt =
        typeof evt.data.endedAt === "number" && Number.isFinite(evt.data.endedAt)
          ? evt.data.endedAt
          : evt.ts;
      for (const candidateRunId of candidateRunIds) {
        const entry = params.chatAbortControllers.get(candidateRunId);
        const eventLifecycleGeneration = evt.lifecycleGeneration?.trim();
        if (
          entry &&
          (!eventLifecycleGeneration ||
            !entry.lifecycleGeneration ||
            entry.lifecycleGeneration === eventLifecycleGeneration)
        ) {
          entry.projectSessionTerminalPending = true;
          entry.projectSessionTerminalObservedAt = observedAt;
        }
      }
      const trackedEntry = candidateRunIds
        .map((candidateRunId) => params.chatAbortControllers.get(candidateRunId))
        .find((entry) => entry !== undefined);
      const runContext = getAgentRunContext(evt.runId);
      // Match the chat projection owner before preparing the shared terminal write.
      // A bound ACP runtime emits its target key, but the chat link owns the source run.
      const sessionAgentId =
        chatLink?.agentId ?? evt.agentId ?? trackedEntry?.agentId ?? runContext?.agentId;
      const knownSessionKey =
        chatLink?.sessionKey ??
        evt.deliverySessionKey ??
        evt.sessionKey ??
        trackedEntry?.sessionKey ??
        runContext?.sessionKey;
      const eventLifecycleGeneration = evt.lifecycleGeneration?.trim();
      const terminalAuthority =
        evt.contextClaimId && eventLifecycleGeneration
          ? {
              claimId: evt.contextClaimId,
              lifecycleGeneration: eventLifecycleGeneration,
              runId: evt.runId,
            }
          : undefined;
      const trackedOwnerIsCurrent =
        !trackedEntry ||
        !eventLifecycleGeneration ||
        !trackedEntry.lifecycleGeneration ||
        trackedEntry.lifecycleGeneration === eventLifecycleGeneration;
      const claimIsComplete = !evt.contextClaimId || terminalAuthority !== undefined;
      const canPersistTerminal =
        isDefinitiveRunLifecycle({ phase: lifecyclePhase, data: evt.data }) &&
        evt.projectSessionLifecycle !== false &&
        trackedOwnerIsCurrent &&
        claimIsComplete;
      const writeContext = captureAgentRunTerminalWriteContext(evt.runId);
      const prepareTerminalPersistence = (sessionKey: string) => {
        const persistence = sessionLifecyclePersistence.observe({
          sessionKey,
          ...(sessionAgentId ? { agentId: sessionAgentId } : {}),
          event: evt,
          ...(terminalAuthority ? { authority: terminalAuthority } : {}),
          ...(writeContext ? { writeContext } : {}),
          ...(clientRunId !== evt.runId ? { clientRunId } : {}),
        });
        if (terminalAuthority) {
          // A failed lazy handler cannot consume the prepared write and release
          // its claim. Persistence settlement becomes that cleanup boundary.
          const clearTerminalAuthority = () =>
            clearAgentRunContext(
              terminalAuthority.runId,
              terminalAuthority.lifecycleGeneration,
              terminalAuthority.claimId,
            );
          failedDispatchCleanup = () => {
            void persistence.then(clearTerminalAuthority, clearTerminalAuthority);
          };
        }
        clearTrackedActiveRun({ runId: evt.runId, clientRunId });
        const tracked = trackTrackedRunTerminalPersistence({
          runId: evt.runId,
          clientRunId,
          sessionId: evt.sessionId,
          persistence,
        });
        if (!tracked) {
          void persistence.catch((error: unknown) => {
            params.log.warn("Terminal session persistence failed", { runId: evt.runId, error });
          });
        }
        void persistence.then(
          () => settleTrackedTerminal({ runId: evt.runId, clientRunId }),
          () => settleTrackedTerminal({ runId: evt.runId, clientRunId, persisted: false }),
        );
        return persistence;
      };
      if (canPersistTerminal) {
        if (knownSessionKey) {
          const persistence = prepareTerminalPersistence(knownSessionKey);
          writeContext?.track(persistence);
        } else {
          // Context cleanup can precede a terminal event. Resolve its persisted
          // run mapping before the lazy chat handler consumes the same event.
          terminalPreparation = getSessionKeyModule().then(async ({ resolveSessionKeyForRun }) => {
            const sessionKey = resolveSessionKeyForRun(
              evt.runId,
              sessionAgentId ? { agentId: sessionAgentId } : undefined,
            );
            if (sessionKey) {
              await prepareTerminalPersistence(sessionKey);
            }
          });
          writeContext?.track(terminalPreparation);
        }
      }
    } else if (lifecyclePhase === "start") {
      const chatLink = evt.contextClaimId
        ? undefined
        : params.chatRunState.registry.peek(evt.runId);
      const clientRunId = chatLink?.clientRunId ?? evt.runId;
      const candidateRunIds = evt.runId === clientRunId ? [evt.runId] : [evt.runId, clientRunId];
      const eventLifecycleGeneration = evt.lifecycleGeneration?.trim();
      for (const candidateRunId of candidateRunIds) {
        const entry = params.chatAbortControllers.get(candidateRunId);
        if (
          entry &&
          (!eventLifecycleGeneration ||
            !entry.lifecycleGeneration ||
            entry.lifecycleGeneration === eventLifecycleGeneration)
        ) {
          entry.projectSessionTerminalPending = false;
          entry.projectSessionTerminalObservedAt = undefined;
        }
      }
    }
    const dispatchPreparation = terminalPreparation;
    const dispatch = dispatchEventHandler<AgentEventRuntimePayload>({
      loadHandler: dispatchPreparation
        ? async () => {
            await dispatchPreparation;
            return getAgentEventHandler();
          }
        : getAgentEventHandler,
      event: evt,
      log: params.log,
      failureMessage: "Agent event dispatch failed",
      context: { runId: evt.runId, stream: evt.stream },
      onFailure: () => failedDispatchCleanup?.(),
    });
    agentEventDispatches.add(dispatch);
    void dispatch.then(() => agentEventDispatches.delete(dispatch));
  });
  const agentUnsub = async () => {
    unsubscribeAgentEvents();
    params.signal.removeEventListener("abort", stopSessionBackgroundWork);
    stopSessionBackgroundWork();
    await sessionBackgroundStop;
    unsubscribePrivateAuditEvents?.();
    unsubscribeToolAuditEvents?.();
    unsubscribeMessageAuditEvents?.();
    clearExecutionDecisionWorkSink();
    clearExecutionIdentityAdmissionSink();
    clearChannelAdmissionEvidenceCollection();
    clearChannelAdmissionDecisionSink();
    clearMessageActionDecisionSink();
    clearRuntimeActionDecisionSink();
    // A missing-key terminal can still be resolving its persisted run mapping.
    // Join dispatch first so handler consumption precedes persistence drain.
    await Promise.allSettled(agentEventDispatches);
    await agentEventHandlerLoader
      .peek()
      ?.then((handler) => handler.dispose())
      .catch(() => undefined);
    await sessionLifecyclePersistence.drain();
    await auditRecorder.stop();
  };

  const heartbeatUnsub = onHeartbeatEvent((evt) => {
    params.broadcast("heartbeat", evt, { dropIfSlow: true });
  });

  const transcriptUnsub = onInternalSessionTranscriptUpdate((evt) => {
    sessionActivitySummaries.handleTranscript(evt);
    void dispatchEventHandler({
      loadHandler: getTranscriptUpdateHandler,
      event: evt,
      log: params.log,
      failureMessage: "Transcript update dispatch failed",
      context: { sessionKey: evt.sessionKey },
    });
  });

  const unsubscribeProfileChanges = onUserProfilesChanged(() => {
    params.refreshConnectedUserProfiles();
    params.broadcastToConnIds(
      "sessions.changed",
      { reason: "profile-identity" },
      params.sessionEventSubscribers.getAll(),
    );
  });
  const unsubscribeLifecycle = onSessionLifecycleEvent((evt) => {
    sessionActivitySummaries.handleLifecycle(evt);
    if (evt.reason === "progress-card-reset" && evt.agentId) {
      // Card readers need not subscribe to session lists. Preserve the canonical
      // owner tuple even when distinct global rows share a display key.
      params.broadcast(
        "progressCard.changed",
        { sessionKey: sessionObserverScopeKey(evt.sessionKey, evt.agentId), revision: null },
        { sessionKeys: [evt.sessionKey], agentId: evt.agentId },
      );
      return;
    }
    void dispatchEventHandler({
      loadHandler: getLifecycleEventHandler,
      event: evt,
      log: params.log,
      failureMessage: "Lifecycle event dispatch failed",
      context: { sessionKey: evt.sessionKey },
    });
  });
  const unsubscribeSuspension = onGatewaySuspendAdmissionChange((phase) => {
    params.broadcast("gateway.suspension", { phase });
  });
  const lifecycleUnsub = () => {
    unsubscribeSuspension();
    unsubscribeProfileChanges();
    unsubscribeLifecycle();
  };

  const taskUnsub = startGatewayTaskSubscriptions(params);

  return {
    sessionActivitySummaries,
    sessionCompanion,
    sessionObserver,
    agentUnsub,
    heartbeatUnsub,
    transcriptUnsub,
    lifecycleUnsub,
    taskUnsub,
  };
}
