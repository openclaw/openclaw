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
import { onGatewaySuspendAdmissionChange } from "../process/gateway-work-admission.js";
import {
  onSessionIdentityMutation,
  onSessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { createLazyPromise, createLazyPromiseLoader } from "../shared/lazy-runtime.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { isTerminalTaskStatus } from "../tasks/task-executor-policy.js";
import type { TaskRegistryObserverEvent } from "../tasks/task-registry.store.js";
import {
  markChatAbortTerminalPersistenceError,
  removeChatAbortControllerEntry,
} from "./chat-abort-lifecycle-internal.js";
import type { ChatAbortControllerEntry, RestartRecoveryCandidate } from "./chat-abort.js";
import type { LiveActivityCoordinator } from "./live-activity-coordinator.js";
import { readLiveActivitySource, type LiveActivitySource } from "./live-activity-source.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import type {
  ChatRunState,
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
  ToolEventRecipientRegistry,
} from "./server-chat-state.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import { mapTaskSummary, type TaskEventPayload } from "./server-methods/task-summary.js";
import { defaultSessionCompanionContextReader } from "./session-companion-context.js";
import { createSessionCompanion } from "./session-companion.js";
import type { SessionLifecyclePersistenceOwner } from "./session-lifecycle-persistence-owner.js";
import { sessionObserverScopeKey } from "./session-observer-model.js";
import { createSessionObserver } from "./session-observer.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "./session-request-agent.js";
import { resolveTaskRequesterSessionTarget } from "./task-session-access.js";
import type { TerminalSessionManager } from "./terminal/session-manager.js";

function dispatchEventHandler<TEvent>(params: {
  loadHandler: () => Promise<(event: TEvent) => unknown>;
  event: TEvent;
  log: SubsystemLogger;
  failureMessage: string;
  context: Record<string, unknown>;
  onFailure?: () => void;
}) {
  return params
    .loadHandler()
    .then((handler) => handler(params.event))
    .then(() => undefined)
    .catch((error: unknown) => {
      params.log.warn(params.failureMessage, { ...params.context, error });
      params.onFailure?.();
    });
}

function terminalTaskId(event: TaskRegistryObserverEvent): string | undefined {
  if (event.kind !== "upserted" || !isTerminalTaskStatus(event.task.status)) {
    return undefined;
  }
  if (event.previous && isTerminalTaskStatus(event.previous.status)) {
    return undefined;
  }
  return event.task.taskId;
}

/** Register gateway runtime event subscriptions and return unsubscribe handles. */
export function startGatewayEventSubscriptions(params: {
  log: SubsystemLogger;
  broadcast: GatewayBroadcastFn;
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: { dropIfSlow?: boolean },
  ) => void;
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
  liveActivityCoordinator?: LiveActivityCoordinator;
  sessionLifecyclePersistence: SessionLifecyclePersistenceOwner;
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
  const sessionLifecyclePersistence = params.sessionLifecyclePersistence;
  const unsubscribeActivityIdentity = params.liveActivityCoordinator
    ? onSessionIdentityMutation(params.liveActivityCoordinator.retireSession)
    : undefined;
  const agentEventDispatches = new Set<Promise<void>>();
  const trackedRunIds = (runId: string, clientRunId: string) =>
    runId === clientRunId ? [runId] : [runId, clientRunId];
  const trackedEntries = (run: {
    runId: string;
    clientRunId: string;
    source?: LiveActivitySource;
  }) =>
    run.source
      ? params.chatAbortControllers.get(run.source.publicRunId) === run.source.entry &&
        run.source.entry.liveActivityFact?.source === run.source
        ? [[run.source.publicRunId, run.source.entry] as const]
        : []
      : trackedRunIds(run.runId, run.clientRunId).flatMap((id) => {
          const entry = params.chatAbortControllers.get(id);
          return entry ? [[id, entry] as const] : [];
        });
  const clearTrackedActiveRun = (run: {
    runId: string;
    clientRunId: string;
    source?: LiveActivitySource;
  }) => {
    for (const [candidateRunId, entry] of trackedEntries(run)) {
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
    persistence?: Promise<void>;
    source?: LiveActivitySource;
  }) => {
    const persisted = run.persisted ?? true;
    for (const [candidateRunId, entry] of trackedEntries(run)) {
      if (run.persistence && entry.projectSessionTerminalPersistence !== run.persistence) {
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
    source?: LiveActivitySource;
  }) => {
    let tracked = false;
    for (const [candidateRunId, entry] of trackedEntries(run)) {
      tracked = true;
      entry.projectSessionTerminalPersistence = run.persistence;
      void run.persistence.catch((error: unknown) => {
        if (entry.projectSessionTerminalPersistence === run.persistence) {
          markChatAbortTerminalPersistenceError(entry, error);
        }
      });
      const lifecycleGeneration = entry.lifecycleGeneration?.trim();
      const sessionKey = entry.sessionKey.trim();
      const sessionId = run.sessionId?.trim() || entry.sessionId.trim();
      // Lazy chat consumption must retain the terminal time stamped at ingress.
      const observedAt = entry.projectSessionTerminalObservedAt;
      if (entry.controlUiVisible !== false && lifecycleGeneration && sessionKey && sessionId) {
        void run.persistence.catch(() => {
          if (params.chatAbortControllers.get(candidateRunId) !== entry) {
            return;
          }
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
            nodeSendToSession: params.nodeSendToSession,
            agentRunSeq: params.agentRunSeq,
            chatRunState: params.chatRunState,
            resolveSessionKeyForRun,
            clearAgentRunContext,
            toolEventRecipients: params.toolEventRecipients,
            sessionEventSubscribers: params.sessionEventSubscribers,
            sessionMessageSubscribers: params.sessionMessageSubscribers,
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
        }),
    );
    return lifecycleEventHandlerPromise;
  };

  const unsubscribeAgentEvents = onAgentRuntimeEvent((evt) => {
    let failedDispatchCleanup: (() => void) | undefined;
    let terminalPreparation: Promise<void> | undefined;
    // Abort listeners can replace the public registration before its terminal
    // event reaches us. Bind the captured predecessor before any owner lookup.
    void sessionLifecyclePersistence.attachLocalAbortSource(evt);
    try {
      params.liveActivityCoordinator?.observeRuntimeEvent(evt);
    } catch {
      params.log.warn("Live Activity source observation failed");
    }
    sessionObserver.handleEvent(evt);
    if (auditEnabled) {
      auditRecorder.record(evt);
    }
    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string"
        ? evt.data.phase
        : undefined;
    if (lifecyclePhase === "start" || lifecyclePhase === "end" || lifecyclePhase === "error") {
      const source = readLiveActivitySource(evt);
      const chatLink =
        source || evt.contextClaimId ? undefined : params.chatRunState.registry.peek(evt.runId);
      const clientRunId = source?.publicRunId ?? chatLink?.clientRunId ?? evt.runId;
      const entries = trackedEntries({ runId: evt.runId, clientRunId, source });
      const eventLifecycleGeneration = evt.lifecycleGeneration?.trim();
      const observedAt =
        typeof evt.data.endedAt === "number" && Number.isFinite(evt.data.endedAt)
          ? evt.data.endedAt
          : evt.ts;
      for (const [, entry] of entries) {
        if (
          !eventLifecycleGeneration ||
          !entry.lifecycleGeneration ||
          entry.lifecycleGeneration === eventLifecycleGeneration
        ) {
          entry.projectSessionTerminalPending = lifecyclePhase !== "start";
          entry.projectSessionTerminalObservedAt =
            lifecyclePhase === "start" ? undefined : observedAt;
        }
      }
      if (lifecyclePhase !== "start") {
        const trackedEntry = source?.entry ?? entries[0]?.[1];
        const runContext = getAgentRunContext(evt.runId);
        const sessionAgentId =
          source?.agentId ?? trackedEntry?.agentId ?? evt.agentId ?? runContext?.agentId;
        const knownSessionKey =
          source?.sessionKey ??
          evt.deliverySessionKey ??
          evt.sessionKey ??
          trackedEntry?.sessionKey ??
          runContext?.sessionKey;
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
          clearTrackedActiveRun({ runId: evt.runId, clientRunId, source });
          const tracked = trackTrackedRunTerminalPersistence({
            runId: evt.runId,
            clientRunId,
            sessionId: evt.sessionId,
            persistence,
            source,
          });
          if (!tracked) {
            void persistence.catch((error: unknown) => {
              params.log.warn("Terminal session persistence failed", { runId: evt.runId, error });
            });
          }
          void persistence.then(
            () => settleTrackedTerminal({ runId: evt.runId, clientRunId, persistence, source }),
            () =>
              settleTrackedTerminal({
                runId: evt.runId,
                clientRunId,
                persistence,
                source,
                persisted: false,
              }),
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
            terminalPreparation = getSessionKeyModule().then(
              async ({ resolveSessionKeyForRun }) => {
                const sessionKey = resolveSessionKeyForRun(
                  evt.runId,
                  sessionAgentId ? { agentId: sessionAgentId } : undefined,
                );
                if (sessionKey) {
                  await prepareTerminalPersistence(sessionKey);
                }
              },
            );
            writeContext?.track(terminalPreparation);
          }
        }
      }
    }
    const dispatchPreparation = terminalPreparation;
    const dispatch = dispatchEventHandler<AgentEventRuntimePayload>({
      loadHandler: dispatchPreparation
        ? () => dispatchPreparation.then(() => getAgentEventHandler())
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
    params.liveActivityCoordinator?.beginClose();
    unsubscribeAgentEvents();
    sessionCompanion.dispose();
    sessionObserver.dispose();
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
    unsubscribeActivityIdentity?.();
    await params.liveActivityCoordinator?.stop();
    await auditRecorder.stop();
  };

  const heartbeatUnsub = onHeartbeatEvent((evt) => {
    params.broadcast("heartbeat", evt, { dropIfSlow: true });
  });

  const transcriptUnsub = onInternalSessionTranscriptUpdate((evt) => {
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

  let taskObserverDisposed = false;
  const lastTaskSummaryById = new Map<string, string>();
  const taskObservers = {
    onEvent: (event: TaskRegistryObserverEvent) => {
      let payload: TaskEventPayload;
      let sessionTarget: ReturnType<typeof resolveTaskRequesterSessionTarget>;
      switch (event.kind) {
        case "upserted": {
          const task = mapTaskSummary(event.task);
          const summary = JSON.stringify(task);
          if (lastTaskSummaryById.get(task.id) === summary) {
            return;
          }
          lastTaskSummaryById.set(task.id, summary);
          payload = { action: "upserted", task };
          sessionTarget = resolveTaskRequesterSessionTarget(event.task);
          break;
        }
        case "deleted":
          lastTaskSummaryById.delete(event.taskId);
          payload = { action: "deleted", taskId: event.taskId };
          sessionTarget = resolveTaskRequesterSessionTarget(event.previous);
          break;
        case "restored":
          lastTaskSummaryById.clear();
          payload = { action: "restored" };
          break;
      }
      params.broadcast("task", payload, {
        dropIfSlow: true,
        ...(sessionTarget
          ? { sessionKeys: [sessionTarget.sessionKey], agentId: sessionTarget.agentId }
          : {}),
      });
      const taskId = terminalTaskId(event);
      if (taskId) {
        params.terminalSessions.closeTaskSessions(taskId);
      }
    },
  };
  const taskObserverRuntimePromise = import("../tasks/task-registry.store.js").then((module) => {
    if (!taskObserverDisposed) {
      module.configureTaskRegistryRuntime({ observers: taskObservers });
    }
    return module;
  });
  void taskObserverRuntimePromise.catch((error: unknown) => {
    params.log.warn("Task registry observer registration failed", { error });
  });
  // The observer slot is a process-wide singleton. Cleanup returns its promise
  // so shutdown can await it, and only clears the slot when it still holds
  // this subscription's observer — a replacement gateway may have registered
  // its own observer before a stale deferred dispose runs.
  const taskUnsub = () => {
    taskObserverDisposed = true;
    return taskObserverRuntimePromise
      .then((module) => {
        if (module.getTaskRegistryObservers() === taskObservers) {
          module.configureTaskRegistryRuntime({ observers: null });
        }
      })
      .catch(() => undefined);
  };

  return {
    sessionCompanion,
    sessionObserver,
    agentUnsub,
    heartbeatUnsub,
    transcriptUnsub,
    lifecycleUnsub,
    taskUnsub,
  };
}
