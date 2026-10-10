// Gateway event subscription wiring for agent, heartbeat, transcript, and lifecycle broadcasts.
import { isAgentLifecycleYieldedWaiting } from "../agents/agent-lifecycle-parent-state.js";
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
import { createChannelAdmissionAudit } from "../channels/message-access/admission-evidence.js";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  type AgentEventRuntimePayload,
  onAgentAuditEvent,
  onAgentRuntimeEvent,
} from "../infra/agent-events.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  getAgentRunContextOwnerStatus,
} from "../infra/agent-run-registry.js";
import { captureAgentRunTerminalWriteContext } from "../infra/agent-run-terminal-writes.js";
import { onTrustedToolExecutionEvent } from "../infra/diagnostic-events.js";
import { notifyGatewayWorkMetricsChanged } from "../infra/gateway-work-metrics-events.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import {
  onGatewaySuspendAdmissionChange,
  runWithRetainedGatewayRootWork,
} from "../process/gateway-work-admission.js";
import {
  onSessionIdentityMutation,
  onSessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";
import {
  onInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createLazyPromiseLoader,
  createLazyRuntimeModule,
  createLazyRuntimeSurface,
} from "../shared/lazy-runtime.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import {
  bindChatAbortTerminalDispatch,
  captureChatAbortRegistrationGuard,
  isCurrentChatAbortTerminalDispatch,
  markChatAbortTerminalPersistenceError,
  markChatAbortTerminalOutcome,
  type ChatAbortTerminalDispatch,
} from "./chat-abort-lifecycle-internal.js";
import { type ChatAbortControllerEntry, removeChatAbortControllerEntry } from "./chat-abort.js";
import { bumpGatewayAccessRevision } from "./gateway-access-revision.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import type { GatewayEventSubscriptionParams } from "./server-runtime-subscriptions.types.js";
import { createSessionActivitySummaries } from "./session-activity-summaries.js";
import { broadcastSessionActivitySummary } from "./session-activity-summary-events.js";
import { defaultSessionCompanionContextReader } from "./session-companion-context.js";
import { createSessionCompanion } from "./session-companion.js";
import { createSessionLifecyclePersistenceOwner } from "./session-lifecycle-persistence-owner.js";
import { sessionObserverScopeKey } from "./session-observer-model.js";
import { createSessionObserver } from "./session-observer.js";
import {
  tryResolveSessionCompatibilityOwnerAgentId,
  resolveSessionEventAgentScope,
} from "./session-request-agent.js";
import type { SessionRowProjection } from "./session-row-projection.js";

function dispatchEventHandler<TEvent>(params: {
  loadHandler: () => Promise<(event: TEvent) => unknown>;
  event: TEvent;
  log: SubsystemLogger;
  failureMessage: string;
  context: Record<string, unknown>;
  isDeliveryCurrent?: () => boolean;
  onFailure?: (error: unknown) => void;
}) {
  return runWithRetainedGatewayRootWork(() =>
    params
      .loadHandler()
      .then((handler) =>
        params.isDeliveryCurrent?.() === false ? undefined : handler(params.event),
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        params.log.warn(params.failureMessage, { ...params.context, error });
        params.onFailure?.(error);
      }),
  );
}

/** Register gateway runtime event subscriptions and return unsubscribe handles. */
export function startGatewayEventSubscriptions(params: GatewayEventSubscriptionParams) {
  // Collection changes gate new work; the writer retains accepted work and maintenance.
  const auditRecorder = createAuditEventRecorder({
    getConfig: getRuntimeConfig,
    scheduler: params.scheduler,
  });
  const clearAuditSinks = [
    configureExecutionIdentityAdmissionSink(auditRecorder.recordExecutionIdentity),
    configureExecutionDecisionWorkSink(auditRecorder.recordExecutionDecisionWork),
    configureMessageActionDecisionSink(auditRecorder.recordExecutionDecision),
    configureRuntimeActionDecisionSink(auditRecorder.recordExecutionDecision),
  ];
  const channelAdmissionAudit = createChannelAdmissionAudit({
    enabled: isExecutionIdentityCollectionEnabled(getRuntimeConfig()),
    decisionSink: auditRecorder.recordExecutionDecision,
  });
  let auditPolicyClosed = false;
  let unsubscribeMessageAuditEvents: (() => void) | undefined;
  const reconcileAuditPolicy = (config: OpenClawConfig) => {
    if (auditPolicyClosed) {
      return;
    }
    channelAdmissionAudit.configure(isExecutionIdentityCollectionEnabled(config));
    if (isAuditLedgerEnabled(config) && resolveAuditMessageMode(config) !== "off") {
      unsubscribeMessageAuditEvents ??= onTrustedMessageAuditEvent(auditRecorder.recordMessage);
    } else {
      unsubscribeMessageAuditEvents?.();
      unsubscribeMessageAuditEvents = undefined;
    }
  };
  reconcileAuditPolicy(getRuntimeConfig());
  const sessionActivitySummaries = createSessionActivitySummaries({
    scheduler: params.scheduler,
    getConfig: getRuntimeConfig,
    getSessionRowProjection: params.getSessionRowProjection,
    onChanged: (target) => {
      if (auditPolicyClosed || params.signal.aborted || params.scheduler.signal.aborted) {
        return;
      }
      // Accepted notifications outlive their producer's scope. agentUnsub joins
      // them before clients and the row projection close.
      const publication = runWithRetainedGatewayRootWork(() =>
        runOutsideAsyncWorkScope(() => broadcastSessionActivitySummary(target, params)),
      ).catch((error: unknown) =>
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
  const unsubscribeObserverEvents = onAgentRuntimeEvent((evt) => {
    void sessionObserver
      .handleEventAsync(evt)
      .catch((error: unknown) => params.log.warn("Session observer event failed", { error }));
  });
  const sessionCompanion = createSessionCompanion({
    scheduler: params.scheduler,
    contextReader: defaultSessionCompanionContextReader,
    getConfig: getRuntimeConfig,
    sessionObserver,
  });
  let sessionBackgroundStop: Promise<void> | undefined;
  // Auxiliary model calls can inherit request work; cancel before that work drains.
  const stopSessionBackgroundWork = (): void => {
    if (!sessionBackgroundStop) {
      // Chat and terminal persistence still consume events while the observer drains.
      unsubscribeObserverEvents();
      sessionCompanion.dispose();
      sessionBackgroundStop = Promise.all([
        sessionObserver.disposeAsync(),
        sessionActivitySummaries.dispose(),
      ]).then(() => undefined);
      void sessionBackgroundStop.catch((error: unknown) => {
        params.log.warn(`session background cleanup failed: ${String(error)}`);
      });
    }
  };
  params.signal.addEventListener("abort", stopSessionBackgroundWork, { once: true });
  if (params.signal.aborted) {
    stopSessionBackgroundWork();
  }
  const unsubscribePrivateAuditEvents = onAgentAuditEvent(auditRecorder.record);
  const unsubscribeToolAuditEvents = onTrustedToolExecutionEvent(auditRecorder.recordTool);
  const sessionLifecyclePersistence = createSessionLifecyclePersistenceOwner(params.scheduler);
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
      notifyGatewayWorkMetricsChanged();
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
  const settleTrackedTerminalEntry = (
    runId: string,
    entry: ChatAbortControllerEntry,
    persisted: boolean,
    error?: unknown,
  ) => {
    entry.projectSessionTerminalPending = false;
    entry.projectSessionTerminalPersistence = undefined;
    entry.projectSessionTerminalPersisted = persisted;
    markChatAbortTerminalPersistenceError(entry, error);
    if (entry.registrationCleanupRequested === true) {
      removeChatAbortControllerEntry(params.chatAbortControllers, runId, entry);
    }
  };
  const settleTrackedTerminal = (run: { runId: string; clientRunId: string }) => {
    for (const candidateRunId of trackedRunIds(run.runId, run.clientRunId)) {
      const entry = params.chatAbortControllers.get(candidateRunId);
      if (entry && !entry.projectSessionTerminalPersistence) {
        settleTrackedTerminalEntry(candidateRunId, entry, false);
      }
    }
  };
  const trackedTerminalWrites = new WeakSet<Promise<void>>();
  const trackTrackedRunTerminalPersistence = (run: {
    runId: string;
    clientRunId: string;
    sessionId?: string;
    persistence: Promise<void>;
  }) => {
    // Ingress and the lazy chat consumer adopt the same prepared write once.
    if (trackedTerminalWrites.has(run.persistence)) {
      return true;
    }
    let tracked = false;
    for (const candidateRunId of trackedRunIds(run.runId, run.clientRunId)) {
      const entry = params.chatAbortControllers.get(candidateRunId);
      if (!entry) {
        continue;
      }
      tracked = true;
      entry.projectSessionTerminalPersisted = false;
      markChatAbortTerminalPersistenceError(entry, undefined);
      entry.projectSessionTerminalPersistence = run.persistence;
      const lifecycleGeneration = entry.lifecycleGeneration?.trim();
      const sessionKey = entry.sessionKey.trim();
      const sessionId = run.sessionId?.trim() || entry.sessionId.trim();
      // Lazy chat consumption must retain the terminal time stamped at ingress.
      const observedAt = entry.projectSessionTerminalObservedAt;
      const settle = (persisted: boolean, error?: unknown) => {
        if (entry.projectSessionTerminalPersistence !== run.persistence) {
          return;
        }
        if (params.chatAbortControllers.get(candidateRunId) === entry) {
          if (persisted) {
            params.restartRecoveryCandidates.delete(candidateRunId);
          } else if (
            entry.controlUiVisible !== false &&
            lifecycleGeneration &&
            sessionKey &&
            sessionId
          ) {
            params.restartRecoveryCandidates.set(candidateRunId, {
              runId: candidateRunId,
              lifecycleGeneration,
              sessionKey,
              sessionId,
              observedAt,
            });
          }
        }
        // Captured drain targets still need final facts after registry retirement.
        settleTrackedTerminalEntry(candidateRunId, entry, persisted, error);
      };
      void run.persistence.then(
        () => settle(true),
        (error: unknown) => settle(false, error),
      );
    }
    if (tracked) {
      trackedTerminalWrites.add(run.persistence);
    }
    return tracked;
  };
  const getSessionKeyModule = createLazyRuntimeModule(() => import("./server-session-key.js"));
  const agentEventHandlerLoader = createLazyPromiseLoader(
    () => {
      // Lazy-load heavy chat modules only after the first agent event reaches the gateway.
      return Promise.all([import("./server-chat.js"), getSessionKeyModule()]).then(
        ([{ createAgentEventHandler }, { resolveSessionForRun }]) =>
          createAgentEventHandler({
            broadcast: params.broadcast,
            broadcastToConnIds: params.broadcastToConnIds,
            nodeHasSessionSubscribers: params.nodeHasSessionSubscribers,
            nodeSendToSession: params.nodeSendToSession,
            agentRunSeq: params.agentRunSeq,
            chatRunState: params.chatRunState,
            resolveSessionKeyForRun: (runId, options) =>
              resolveSessionForRun(runId, {
                ...options,
                projection: params.getSessionRowProjection?.(),
              })?.sessionKey,
            clearAgentRunContext,
            toolEventRecipients: params.toolEventRecipients,
            sessionEventSubscribers: params.sessionEventSubscribers,
            sessionMessageSubscribers: params.sessionMessageSubscribers,
            getSessionRowProjection: params.getSessionRowProjection,
            loadGatewaySessionLifecycleSnapshotForEvent: (key, options) => {
              // Tool progress must not wait for optional row enrichment before reply capture.
              const owner = options?.ownerEvent
                ? eventRowOwners.get(options.ownerEvent)
                : undefined;
              if (
                options?.ownerEvent
                  ? !owner?.record || !owner.projection.isCurrent(owner.record)
                  : params.getSessionRowProjection?.()?.needsMaterialization
              ) {
                return { row: null };
              }
              const scope = resolveSessionEventAgentScope(
                getRuntimeConfig(),
                key,
                options?.agentId,
              );
              const read = options?.sessionRows;
              const prepared = scope?.[1] ? read?.describe({ key, agentId: scope[1] }) : undefined;
              const snapshot = scope?.[1]
                ? read
                  ? prepared
                    ? { row: read.present(prepared), lifecycleRunId: prepared.entry.lifecycleRunId }
                    : { row: null }
                  : (params.getSessionRowProjection?.()?.snapshot({ key, agentId: scope[1] }) ?? {
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
              for (const candidateRunId of trackedRunIds(runId, clientRunId)) {
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
  const getSessionEventsModule = createLazyRuntimeModule(
    () => import("./server-session-events.js"),
  );

  const getTranscriptUpdateHandler = createLazyRuntimeSurface(
    getSessionEventsModule,
    ({ createTranscriptUpdateBroadcastHandler }) => createTranscriptUpdateBroadcastHandler(params),
  );
  const getLifecycleEventHandler = createLazyRuntimeSurface(
    getSessionEventsModule,
    ({ createLifecycleEventBroadcastHandler }) => createLifecycleEventBroadcastHandler(params),
  );

  const handleAgentEvent = (evt: AgentEventRuntimePayload, isDeliveryCurrent = () => true) => {
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
    let terminalEntries: Map<string, ChatAbortControllerEntry> | undefined;
    sessionActivitySummaries.handleEvent(evt);
    auditRecorder.record(evt);
    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string"
        ? evt.data.phase
        : undefined;
    if (lifecyclePhase === "start" || lifecyclePhase === "end" || lifecyclePhase === "error") {
      const eventLifecycleGeneration = evt.lifecycleGeneration?.trim();
      const terminal = lifecyclePhase !== "start";
      const definitiveTerminal =
        terminal && isDefinitiveRunLifecycle({ phase: lifecyclePhase, data: evt.data });
      const terminalOwnerCurrent =
        !evt.contextClaimId ||
        (evt.lifecycleGeneration &&
          getAgentRunContextOwnerStatus(evt.runId, evt.contextClaimId, evt.lifecycleGeneration) ===
            "active");
      const chatLink = evt.contextClaimId
        ? undefined
        : params.chatRunState.registry.peek(evt.runId);
      const clientRunId = chatLink?.clientRunId ?? evt.runId;
      const candidateRunIds = trackedRunIds(evt.runId, clientRunId);
      const observedAt = terminal
        ? typeof evt.data.endedAt === "number" && Number.isFinite(evt.data.endedAt)
          ? evt.data.endedAt
          : evt.ts
        : undefined;
      for (const candidateRunId of candidateRunIds) {
        const entry = params.chatAbortControllers.get(candidateRunId);
        if (
          entry &&
          (!eventLifecycleGeneration ||
            !entry.lifecycleGeneration ||
            entry.lifecycleGeneration === eventLifecycleGeneration)
        ) {
          entry.projectSessionTerminalPending = terminal;
          entry.projectSessionTerminalObservedAt = observedAt;
          if (
            definitiveTerminal &&
            terminalOwnerCurrent &&
            !isAgentLifecycleYieldedWaiting(evt.data)
          ) {
            markChatAbortTerminalOutcome(entry);
          }
          if (terminal) {
            (terminalEntries ??= new Map()).set(candidateRunId, entry);
          }
        }
      }
      if (terminal) {
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
          definitiveTerminal &&
          evt.projectSessionLifecycle !== false &&
          trackedOwnerIsCurrent &&
          claimIsComplete;
        const writeContext = captureAgentRunTerminalWriteContext(evt.runId);
        const prepareTerminalPersistence = (sessionKey: string, agentId = sessionAgentId) => {
          const persistence = sessionLifecyclePersistence.observe({
            sessionKey,
            ...(agentId ? { agentId } : {}),
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
          return persistence;
        };
        if (canPersistTerminal) {
          if (knownSessionKey) {
            const persistence = prepareTerminalPersistence(knownSessionKey);
            writeContext?.track(persistence);
          } else {
            // Context cleanup can precede a terminal event. Resolve its persisted
            // run mapping before the lazy chat handler consumes the same event.
            terminalPreparation = getSessionKeyModule().then(async ({ resolveSessionForRun }) => {
              const selected = resolveSessionForRun(evt.runId, {
                agentId: sessionAgentId,
                projection: params.getSessionRowProjection?.(),
              });
              if (selected && isDeliveryCurrent()) {
                await prepareTerminalPersistence(selected.sessionKey, selected.agentId);
              }
            });
            writeContext?.track(terminalPreparation);
          }
        }
      }
    }
    const terminalDispatch: Pick<ChatAbortTerminalDispatch, "failure"> | undefined = terminalEntries
      ? {}
      : undefined;
    const dispatch = dispatchEventHandler<AgentEventRuntimePayload>({
      // An extra async hop lets empty queued finalization overtake reply buffer capture.
      loadHandler: () =>
        terminalPreparation
          ? terminalPreparation.then(agentEventHandlerLoader.load)
          : agentEventHandlerLoader.load(),
      isDeliveryCurrent,
      event: evt,
      log: params.log,
      failureMessage: "Agent event dispatch failed",
      context: { runId: evt.runId, stream: evt.stream },
      onFailure: (error) => {
        if (terminalDispatch) {
          terminalDispatch.failure = { error };
          for (const [runId, entry] of terminalEntries ?? []) {
            if (
              isCurrentChatAbortTerminalDispatch(entry, terminalDispatch) &&
              entry.projectSessionTerminalPending === true &&
              !entry.projectSessionTerminalPersistence
            ) {
              // Failed dispatch cannot adopt a write later. Keep the failure for
              // cancellation callers, but release its now-ownerless reservation.
              settleTrackedTerminalEntry(runId, entry, false, error);
            }
          }
        }
        failedDispatchCleanup?.();
      },
    });
    bindChatAbortTerminalDispatch(
      terminalEntries ? [...terminalEntries.values()] : undefined,
      dispatch,
      terminalDispatch,
    );
    agentEventDispatches.add(dispatch);
    void dispatch.then(() => agentEventDispatches.delete(dispatch));
  };
  const unsubscribeAgentEvents = onAgentRuntimeEvent(handleAgentEvent, (evt) => {
    if (evt.stream !== "lifecycle") {
      return () => true;
    }
    const runId = evt.runId;
    const chatLink = params.chatRunState.registry.peek(runId);
    const isRegistrationCurrent = captureChatAbortRegistrationGuard(
      params.chatAbortControllers,
      trackedRunIds(runId, chatLink?.clientRunId ?? runId),
    );
    return () =>
      evt.runId === runId &&
      (!params.chatRunState.registry.peek(runId) ||
        params.chatRunState.registry.peek(runId) === chatLink) &&
      isRegistrationCurrent();
  });
  const agentUnsub = async () => {
    auditPolicyClosed = true;
    unsubscribeAgentEvents();
    params.signal.removeEventListener("abort", stopSessionBackgroundWork);
    stopSessionBackgroundWork();
    await sessionBackgroundStop;
    unsubscribePrivateAuditEvents();
    unsubscribeToolAuditEvents();
    unsubscribeMessageAuditEvents?.();
    clearAuditSinks.forEach((clear) => clear());
    channelAdmissionAudit.close();
    // A missing-key terminal can still be resolving its persisted run mapping.
    // Join dispatch first so handler consumption precedes persistence drain.
    await Promise.allSettled(agentEventDispatches);
    await agentEventHandlerLoader
      .peek()
      ?.then((handler) => handler.dispose())
      .catch(() => undefined);
    await sessionLifecyclePersistence.drain();
    // Terminal persistence can publish further committed transcript updates.
    while (agentEventDispatches.size > 0) {
      await Promise.allSettled(agentEventDispatches);
    }
    await auditRecorder.stop();
  };

  const heartbeatUnsub = onHeartbeatEvent((evt) => {
    params.broadcast("heartbeat", evt, { dropIfSlow: true });
  });

  const transcriptUnsub = onInternalSessionTranscriptUpdate((evt) => {
    sessionActivitySummaries.handleTranscript(evt);
    // Retire synchronously before later cumulative updates, but retain the wire
    // projection until this committed row has crossed its async publication path.
    const agentHandler = agentEventHandlerLoader.peek();
    const publication = createDeferredCore();
    const dispatch = runOutsideAsyncWorkScope(() =>
      dispatchEventHandler<InternalSessionTranscriptUpdate>({
        loadHandler: agentHandler
          ? () =>
              agentHandler
                .then(
                  (handler) => handler.retireTranscript(evt, publication.promise),
                  () => undefined,
                )
                .then(getTranscriptUpdateHandler)
          : getTranscriptUpdateHandler,
        event: evt,
        log: params.log,
        failureMessage: "Transcript update dispatch failed",
        context: { sessionKey: evt.sessionKey },
      }),
    );
    agentEventDispatches.add(dispatch);
    void dispatch.then(() => {
      publication.resolve();
      agentEventDispatches.delete(dispatch);
    });
  });

  // Committed resets/rotations can change access after the originating run is gone.
  // Invalidate synchronously before any yielded reader can accept its old access snapshot.
  // Each runtime owns its callback so late disposal cannot remove a replacement's listener.
  const unsubscribeSessionIdentity = onSessionIdentityMutation(() => bumpGatewayAccessRevision());
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
    unsubscribeSessionIdentity();
    unsubscribeSuspension();
    unsubscribeProfileChanges();
    unsubscribeLifecycle();
  };

  return {
    channelAdmissionAudit,
    reconcileAuditPolicy,
    sessionActivitySummaries,
    sessionCompanion,
    sessionObserver,
    agentUnsub,
    heartbeatUnsub,
    transcriptUnsub,
    lifecycleUnsub,
  };
}
