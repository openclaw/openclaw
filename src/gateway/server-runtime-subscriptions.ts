// Gateway event subscription wiring for agent, heartbeat, transcript, and lifecycle broadcasts.
import { isAgentLifecycleYieldedWaiting } from "../agents/agent-lifecycle-parent-state.js";
import { isDefinitiveRunLifecycle } from "../agents/agent-run-terminal-outcome.js";
import { onBackgroundProcessesChanged } from "../agents/bash-process-registry.js";
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
import { captureAgentRunTerminalPersistence } from "../infra/agent-run-terminal-writes.js";
import { onTrustedToolExecutionEvent } from "../infra/diagnostic-events.js";
import { heartbeatNotifications } from "../infra/heartbeat-events.js";
import {
  onGatewaySuspendAdmissionChange,
  retainGatewayRootWorkAdmissionContinuation,
  runWithRetainedGatewayRootWork,
} from "../process/gateway-work-admission.js";
import {
  getRpcSourceForGateway,
  getRpcSourceIdentity,
  getRpcSourceLifecycleGeneration,
  type RpcSourceRef,
} from "../sessions/session-controller.rpc-sources.js";
import {
  onSessionIdentityMutation,
  onSessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
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
  markChatAbortTerminalOutcome,
  type ChatAbortTerminalDispatch,
} from "./chat-abort-lifecycle-internal.js";
import { bumpGatewayAccessRevision } from "./gateway-access-revision.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import { dispatchEventHandler } from "./server-runtime-event-dispatch.js";
import type { GatewayEventSubscriptionParams } from "./server-runtime-subscriptions.types.js";
import { createGatewayTerminalTracking } from "./server-runtime-terminal-tracking.js";
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

/** Register gateway runtime event subscriptions and return unsubscribe handles. */
export function startGatewayEventSubscriptions(params: GatewayEventSubscriptionParams) {
  const getScopedRpcSource = (runId: string) =>
    getRpcSourceForGateway(runId, params.resolveGatewayContext);
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
    getSessionRowProjection: params.getSessionRowProjection,
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
  const sessionLifecyclePersistence = createSessionLifecyclePersistenceOwner();
  const agentEventDispatches = new Set<Promise<void>>();
  const eventRowOwners = new WeakMap<
    AgentEventRuntimePayload,
    { projection: SessionRowProjection; record: ReturnType<SessionRowProjection["capture"]> }
  >();
  const {
    trackedRunIds,
    clearTrackedActiveRun,
    settleTrackedTerminal,
    settleTrackedTerminalEntry,
    trackTrackedRunTerminalPersistence,
  } = createGatewayTerminalTracking({
    getScopedRpcSource,
  });
  const getSessionKeyModule = createLazyRuntimeModule(() => import("./server-session-key.js"));
  // Lazy-load heavy chat modules only after the first agent event reaches the gateway.
  const agentEventHandlerLoader = createLazyPromiseLoader(
    () =>
      Promise.all([import("./server-chat.js"), getSessionKeyModule()]).then(
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
              const event = options?.ownerEvent;
              const owner = event ? eventRowOwners.get(event) : undefined;
              const projection = params.getSessionRowProjection?.();
              if (
                event
                  ? !owner?.record || !owner.projection.isCurrent(owner.record)
                  : projection?.needsMaterialization
              ) {
                return { row: null };
              }
              const scope = resolveSessionEventAgentScope(
                getRuntimeConfig(),
                key,
                options?.agentId,
              );
              if (!scope?.[1]) {
                return { row: null };
              }
              const query = { key, agentId: scope[1] };
              const read = options?.sessionRows;
              const row = !read && !event ? projection?.capture(query) : undefined;
              if (row && !row.materialized && !row.privateSource) {
                return { row: null };
              }
              const prepared = read?.describe(query);
              const record = read ? prepared : (owner?.record ?? row);
              const snapshot = read
                ? prepared
                  ? { row: read.present(prepared), lifecycleRunId: prepared.entry.lifecycleRunId }
                  : { row: null }
                : (projection?.snapshot(query) ?? { row: null });
              return event?.sessionId && snapshot.row?.sessionId !== event.sessionId
                ? { row: null }
                : {
                    ...snapshot,
                    ...(record ? { storePath: record.storeTarget.storePath } : {}),
                  };
            },
            persistGatewaySessionLifecycleEventForEvent: sessionLifecyclePersistence.persist,
            updateRunToolErrorSummary: ({ runId, clientRunId, summary }) => {
              for (const candidateRunId of new Set([runId, clientRunId])) {
                const entry = getScopedRpcSource(candidateRunId);
                if (entry) {
                  entry.adapter.toolErrorSummary = summary;
                }
              }
            },
            clearTrackedActiveRun,
            settleTrackedTerminal,
            trackTrackedRunTerminalPersistence,
            isChatSendRunActive: (runId) => {
              const entry = getScopedRpcSource(runId);
              // This callback identifies the terminal-response owner, not the
              // sessions.list activity projection. Retain it while the source settles.
              return entry !== undefined && entry.adapter.kind !== "agent";
            },
            resolveActiveLifecycleGenerationForRun: (runId) => {
              const entry = getScopedRpcSource(runId);
              return entry ? getRpcSourceLifecycleGeneration(entry) : undefined;
            },
            resolveSessionActiveRunState: (session) => {
              const projection = params.getSessionRowProjection?.();
              const defaultAgentId = tryResolveSessionCompatibilityOwnerAgentId(
                getRuntimeConfig(),
                session.requestedKey,
              );
              const agentId = session.agentId ?? defaultAgentId;
              if (!session.storePath || !agentId) {
                return { active: false, runIds: [] };
              }
              return resolveVisibleActiveSessionRunState({
                ...session,
                storePath: session.storePath,
                resolveGatewayContext: params.resolveGatewayContext,
                projectedAgentRunIndex: projection?.state.rowContext.projectedAgentRuns,
                physicalPaths: projection?.physicalPaths,
                defaultAgentId,
              });
            },
          }),
      ),
    { cacheRejections: true },
  );
  const getSessionEvents = createLazyRuntimeModule(() => import("./server-session-events.js"));

  const transcriptPublications = new Map<Promise<false | void>, Promise<boolean>>();
  const getTranscriptUpdateHandler = createLazyRuntimeSurface(
    getSessionEvents,
    ({ createTranscriptUpdateBroadcastHandler }) => createTranscriptUpdateBroadcastHandler(params),
  );
  const getLifecycleEvents = createLazyRuntimeModule(
    () => import("./server-session-lifecycle-events.js"),
  );
  const getLifecycleEventHandler = createLazyRuntimeSurface(
    getLifecycleEvents,
    ({ createLifecycleEventBroadcastHandler }) => createLifecycleEventBroadcastHandler(params),
  );

  const isNonLifecycleDeliveryCurrent = () => true;
  const handleAgentEvent = (
    evt: AgentEventRuntimePayload,
    isDeliveryCurrent = isNonLifecycleDeliveryCurrent,
  ) => {
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
    let terminalEntries: Map<string, RpcSourceRef> | undefined;
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
        const entry = getScopedRpcSource(candidateRunId);
        const lifecycleGeneration = entry ? getRpcSourceLifecycleGeneration(entry) : undefined;
        if (
          entry &&
          (!eventLifecycleGeneration ||
            !lifecycleGeneration ||
            lifecycleGeneration === eventLifecycleGeneration)
        ) {
          entry.adapter.projectSessionTerminalPending = terminal;
          entry.adapter.projectSessionTerminalObservedAt = observedAt;
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
          .map((candidateRunId) => getScopedRpcSource(candidateRunId))
          .find((entry) => entry !== undefined);
        const runContext = getAgentRunContext(evt.runId);
        const trackedIdentity = trackedEntry ? getRpcSourceIdentity(trackedEntry) : undefined;
        // Match the chat projection owner before preparing the shared terminal write.
        // A bound ACP runtime emits its target key, but the chat link owns the source run.
        const sessionAgentId =
          chatLink?.agentId ?? evt.agentId ?? trackedIdentity?.agentId ?? runContext?.agentId;
        const knownSessionKey =
          chatLink?.sessionKey ??
          evt.deliverySessionKey ??
          evt.sessionKey ??
          trackedIdentity?.sessionKey ??
          runContext?.sessionKey;
        const trackedLifecycleGeneration = trackedEntry
          ? getRpcSourceLifecycleGeneration(trackedEntry)
          : undefined;
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
          !trackedLifecycleGeneration ||
          trackedLifecycleGeneration === eventLifecycleGeneration;
        const claimIsComplete = !evt.contextClaimId || terminalAuthority !== undefined;
        const canPersistTerminal =
          definitiveTerminal &&
          evt.projectSessionLifecycle !== false &&
          trackedOwnerIsCurrent &&
          claimIsComplete;
        const { writeContext, track } =
          evt.terminalPersistence ?? captureAgentRunTerminalPersistence(evt.runId);
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
            track?.(persistence);
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
            track?.(terminalPreparation);
          }
        }
      }
    }
    const terminalDispatch: Pick<ChatAbortTerminalDispatch, "failure"> | undefined = terminalEntries
      ? {}
      : undefined;
    const dispatch = dispatchEventHandler<AgentEventRuntimePayload>({
      // An extra async hop lets empty queued finalization overtake reply buffer capture.
      loadHandler: terminalPreparation
        ? () => terminalPreparation.then(agentEventHandlerLoader.load)
        : agentEventHandlerLoader.load,
      isDeliveryCurrent,
      event: evt,
      log: params.log,
      failureMessage: "Agent event dispatch failed",
      context: { runId: evt.runId, stream: evt.stream },
      onFailure:
        lifecyclePhase === "end" || lifecyclePhase === "error"
          ? (error) => {
              if (terminalDispatch) {
                terminalDispatch.failure = { error };
                for (const [runId, entry] of terminalEntries ?? []) {
                  if (
                    isCurrentChatAbortTerminalDispatch(entry, terminalDispatch) &&
                    entry.adapter.projectSessionTerminalPending === true &&
                    !entry.adapter.projectSessionTerminalPersistence
                  ) {
                    // Failed dispatch cannot adopt a write later. Keep the failure for
                    // cancellation callers, but release its now-ownerless reservation.
                    settleTrackedTerminalEntry(runId, entry, false, error);
                  }
                }
              }
              failedDispatchCleanup?.();
            }
          : undefined,
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
      return isNonLifecycleDeliveryCurrent;
    }
    const runId = evt.runId;
    const chatLink = params.chatRunState.registry.peek(runId);
    const isRegistrationCurrent = captureChatAbortRegistrationGuard(
      trackedRunIds(runId, chatLink?.clientRunId ?? runId).map((candidateRunId) => ({
        runId: candidateRunId,
        entry: getScopedRpcSource(candidateRunId),
      })),
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

  heartbeatNotifications.onEvent = (evt) => {
    params.broadcast("heartbeat", evt, { dropIfSlow: true });
  };

  const transcriptUnsub = onInternalSessionTranscriptUpdate((evt) => {
    // The committing root is a real completion obligation, separate from the
    // bounded presentation job. Capture it before leaving the producer context.
    const releaseRoot = retainGatewayRootWorkAdmissionContinuation();
    const agentHandler = agentEventHandlerLoader.peek();
    const sourcePublication = agentHandler ? createDeferredCore<boolean>() : undefined;
    let handedOff = false;
    const dispatch = runInDetachedAsyncContext(() =>
      dispatchEventHandler({
        loadHandler: async () => {
          if (agentHandler && sourcePublication) {
            await agentHandler.then(
              (handler) => handler.retireTranscript(evt, sourcePublication.promise),
              () => undefined,
            );
          }
          const handler = await getTranscriptUpdateHandler();
          return (event) => {
            const task = handler(event);
            let publication = transcriptPublications.get(task);
            if (!publication) {
              publication = task.then(
                (result) => result !== false,
                (error: unknown) => {
                  params.log.warn("Transcript update dispatch failed", {
                    sessionKey: event.sessionKey,
                    error,
                  });
                  return false;
                },
              );
              transcriptPublications.set(task, publication);
              const settled = publication.then(() => undefined);
              agentEventDispatches.add(settled);
              void settled.then(() => {
                transcriptPublications.delete(task);
                agentEventDispatches.delete(settled);
              });
            }
            handedOff = true;
            void publication.then((published) => {
              sourcePublication?.resolve(published);
              releaseRoot?.();
            });
          };
        },
        event: evt,
        log: params.log,
        failureMessage: "Transcript update dispatch failed",
        context: { sessionKey: evt.sessionKey },
      }),
    );
    agentEventDispatches.add(dispatch);
    void dispatch.then(() => {
      if (!handedOff) {
        sourcePublication?.resolve(false);
        releaseRoot?.();
      }
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
    const dispatch = dispatchEventHandler({
      loadHandler: getLifecycleEventHandler,
      event: evt,
      log: params.log,
      failureMessage: "Lifecycle event dispatch failed",
      context: { sessionKey: evt.sessionKey },
    });
    agentEventDispatches.add(dispatch);
    void dispatch.then(() => agentEventDispatches.delete(dispatch));
  });
  const unsubscribeSuspension = onGatewaySuspendAdmissionChange((phase) => {
    params.broadcast("gateway.suspension", { phase });
  });
  const unsubscribeProcesses = onBackgroundProcessesChanged((target) => {
    if (!params.signal.aborted) {
      params.broadcast("sessions.processes.changed", target, {
        sessionKeys: [target.sessionKey],
        agentId: target.agentId,
        dropIfSlow: true,
      });
    }
  });

  return {
    channelAdmissionAudit,
    reconcileAuditPolicy,
    sessionActivitySummaries,
    sessionCompanion,
    sessionObserver,
    agentUnsub,
    transcriptUnsub,
    lifecycleUnsub() {
      unsubscribeProcesses();
      unsubscribeSessionIdentity();
      unsubscribeSuspension();
      unsubscribeProfileChanges();
      unsubscribeLifecycle();
    },
  };
}
