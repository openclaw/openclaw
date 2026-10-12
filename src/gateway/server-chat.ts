// Gateway chat runtime projects agent events into chat/session subscriber
// streams, lifecycle persistence, heartbeat visibility, and live UI updates.
import { performance } from "node:perf_hooks";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { Value } from "typebox/value";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import {
  ChatStatusEventSchema,
  projectChatErrorDetail,
  type ChatEvent,
} from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { isAgentLifecycleYieldedWaiting } from "../agents/agent-lifecycle-parent-state.js";
import {
  AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
  isDefinitiveRunLifecycle,
} from "../agents/agent-run-terminal-outcome.js";
import { isActiveEmbeddedRunId } from "../agents/embedded-agent-runner/runs.js";
import { isTimeoutError, resolveFailoverReasonFromError } from "../agents/failover-error.js";
import { readToolValidationErrorSummary } from "../agents/tool-error-summary.js";
import { normalizeVerboseLevel } from "../auto-reply/thinking.js";
import { normalizeAgentPlanSteps } from "../channels/streaming.js";
import { getRuntimeConfig } from "../config/io.js";
import type { AgentEventPayload, AgentEventRuntimePayload } from "../infra/agent-events.js";
import { getAgentRunContext, getAgentRunContextOwnerStatus } from "../infra/agent-run-registry.js";
import { formatErrorMessage } from "../infra/errors.js";
import { boundedJsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { logError, logWarn } from "../logger.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { isAcpSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";
import type { InternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../shared/assistant-display-content.js";
import { resolveAssistantEventPhase } from "../shared/chat-message-content.js";
import { setSafeTimeout } from "../utils/timer-delay.js";
import { resolveAssistantTextInput } from "./agent-event-assistant-text.js";
import {
  appendChatCanvasBlocks,
  appendChatCanvasBlocksToMessage,
  extractChatToolResultCanvasPreview,
} from "./chat-display-projection.canvas.js";
import { renderChatRunError } from "./chat-error-presentation.js";
import {
  projectLiveAssistantBufferedText,
  shouldSuppressAssistantEventForLiveChat,
} from "./live-chat-projector.js";
import type {
  GatewayBroadcastFn,
  GatewayBroadcastOpts,
  GatewayBroadcastToConnIdsFn,
} from "./server-broadcast-types.js";
import { createAgentEventAdmission } from "./server-chat-event-admission.js";
import {
  normalizeHeartbeatChatFinalText,
  resolveHeartbeatFlag,
  shouldHideHeartbeatChatOutput,
} from "./server-chat-heartbeat.js";
import {
  createSessionLifecyclePublisher,
  type SessionEventSnapshotDependencies,
} from "./server-chat-lifecycle-publication.js";
import {
  mergeAgentTextPayload,
  mergeChatTextPayload,
  assistantWireProjection,
  cancelPendingLiveTextFlush,
  chatWireProjection,
  liveTextDelivery,
  prepareAgentWirePayload,
  scheduleLiveTextFlush,
} from "./server-chat-live-text.js";
import { isChatAbortMarkerCurrent } from "./server-chat-state.js";
import type {
  BufferedAgentEvent,
  ChatRunEntry,
  ChatRunState,
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import type { ToolEventRecipientRegistry } from "./server-chat-tool-recipients.js";
import { createChatTranscriptPublication } from "./server-chat-transcript-publication.js";
import { roundedChatSendTimingMs } from "./server-methods/chat-server-timing.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "./session-request-agent.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { resolveSessionSubscriptionKeys } from "./session-subscription-keys.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";
import { formatForLog } from "./ws-log.js";

export {
  createChatAbortMarker,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
const CHAT_STATE_BY_TERMINAL_CLASSIFICATION = {
  success: "done",
  timeout: "error",
  cancellation: "aborted",
  failure: "error",
} as const;
// Canvas document retention and native Quick Chat both keep at most 32 widgets.
// Keep the newest handles, independently of tool-progress verbosity and eviction.
const MAX_LIVE_CANVAS_BLOCKS = 32;
const MAX_LIVE_CANVAS_BYTES = 64 * 1024;

function shouldMirrorAssistantEventToHiddenSessionMessages(
  data: AgentEventPayload["data"],
): boolean {
  return (
    ((typeof data.text === "string" && data.text.length > 0) ||
      (typeof data.delta === "string" && data.delta.length > 0)) &&
    resolveAssistantEventPhase(data) === "commentary"
  );
}

const LIVE_TEXT_PACING_MS = 75;

export type NodeSendToSession = (
  sessionKey: string,
  event: string,
  payload: unknown,
  opts?: GatewayBroadcastOpts,
) => void;

// Derived from ChatErrorEventSchema.errorKind (gateway-protocol); keep set in sync.
type ChatErrorKind = NonNullable<Extract<ChatEvent, { state: "error" }>["errorKind"]>;

const CHAT_ERROR_KINDS = new Set<ChatErrorKind>([
  "refusal",
  "timeout",
  "rate_limit",
  "context_length",
  "unknown",
]);

function readChatErrorKind(value: unknown): ChatErrorKind | undefined {
  return typeof value === "string" && CHAT_ERROR_KINDS.has(value as ChatErrorKind)
    ? (value as ChatErrorKind)
    : undefined;
}

// Refusal is a stop-reason fact; other badges use the canonical failover classification.
export function resolveChatErrorKindFromError(error: unknown): ChatErrorKind | undefined {
  if (error === undefined) {
    return undefined;
  }
  const message = formatErrorMessage(error).toLowerCase();
  if (
    message.includes("refusal") ||
    message.includes("content_filter") ||
    message.includes("sensitive")
  ) {
    return "refusal";
  }
  const reason = resolveFailoverReasonFromError(error);
  if (reason === "rate_limit" || reason === "overloaded") {
    return "rate_limit";
  }
  if (reason === "context_overflow") {
    return "context_length";
  }
  // FailoverReason "timeout" is the retryable-transient bucket and deliberately
  // swallows generic 5xx; only genuinely timeout-shaped errors get the badge.
  return isTimeoutError(error) ? "timeout" : undefined;
}

export type AgentEventHandlerOptions = {
  broadcast: GatewayBroadcastFn;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  nodeSendToSession: NodeSendToSession;
  nodeHasSessionSubscribers: (sessionKey: string) => boolean;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  resolveSessionKeyForRun: (runId: string, options?: { agentId?: string }) => string | undefined;
  clearAgentRunContext: (
    runId: string,
    lifecycleGeneration?: string,
    contextClaimId?: string,
  ) => void;
  toolEventRecipients: ToolEventRecipientRegistry;
  sessionEventSubscribers: SessionEventSubscriberRegistry;
  sessionMessageSubscribers: SessionMessageSubscriberRegistry;
  loadGatewaySessionLifecycleSnapshotForEvent?: SessionEventSnapshotDependencies["loadGatewaySessionLifecycleSnapshotForEvent"];
  getSessionRowProjection?: () => SessionRowProjection | undefined;
  persistGatewaySessionLifecycleEventForEvent?: typeof persistGatewaySessionLifecycleEvent;
  lifecycleErrorRetryGraceMs?: number;
  isChatSendRunActive?: (runId: string) => boolean;
  clearTrackedActiveRun?: (params: {
    runId: string;
    clientRunId: string;
    sessionKey: string;
  }) => void;
  settleTrackedTerminal?: (params: {
    runId: string;
    clientRunId: string;
    sessionKey: string;
  }) => void;
  trackTrackedRunTerminalPersistence?: (params: {
    runId: string;
    clientRunId: string;
    sessionKey: string;
    sessionId?: string;
    persistence: Promise<void>;
  }) => void;
  resolveActiveLifecycleGenerationForRun?: (runId: string) => string | undefined;
  updateRunToolErrorSummary?: (params: {
    runId: string;
    clientRunId: string;
    summary: string | undefined;
  }) => void;
  resolveSessionActiveRunState?: SessionEventSnapshotDependencies["resolveSessionActiveRunState"];
};

type AgentEventHandler = ((event: AgentEventPayload) => void | Promise<void>) & {
  retireTranscript: (event: InternalSessionTranscriptUpdate, publication?: Promise<void>) => void;
  dispose: () => Promise<void>;
};

type ChatRunRecord = ReturnType<ChatRunState["getOrCreate"]>;
type AgentTextThrottleStream = keyof NonNullable<ChatRunRecord["agentText"]>;
type LivePayloadOptions = {
  agentId?: string;
  controlUiVisible?: boolean;
  dropIfSlow?: boolean;
  liveText?: GatewayBroadcastOpts["liveText"];
};

type ChatDelivery = {
  sessionKey: string;
  agentId?: string;
  clientRunId: string;
  sourceRunId: string;
  seq: number;
  controlUiVisible?: boolean;
  firstAssistantTimingEntry?: ChatRunEntry;
  isHeartbeat?: boolean;
};

export function createAgentEventHandler({
  broadcast,
  broadcastToConnIds,
  nodeSendToSession,
  nodeHasSessionSubscribers,
  agentRunSeq,
  chatRunState,
  resolveSessionKeyForRun,
  clearAgentRunContext,
  toolEventRecipients,
  sessionEventSubscribers,
  sessionMessageSubscribers,
  loadGatewaySessionLifecycleSnapshotForEvent = () => ({ row: null }),
  getSessionRowProjection,
  persistGatewaySessionLifecycleEventForEvent = persistGatewaySessionLifecycleEvent,
  lifecycleErrorRetryGraceMs = AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
  isChatSendRunActive = () => false,
  clearTrackedActiveRun,
  settleTrackedTerminal,
  trackTrackedRunTerminalPersistence,
  resolveActiveLifecycleGenerationForRun = () => undefined,
  updateRunToolErrorSummary,
  resolveSessionActiveRunState,
}: AgentEventHandlerOptions): AgentEventHandler {
  const shouldProcessOwnedEvent = (
    runId: string,
    claimId: string | undefined,
    lifecycleGeneration: string | undefined,
  ): boolean =>
    !claimId ||
    Boolean(
      lifecycleGeneration &&
      getAgentRunContextOwnerStatus(runId, claimId, lifecycleGeneration) === "active",
    );
  const clearRunContextForEvent = (evt: AgentEventRuntimePayload): void => {
    if (evt.contextClaimId) {
      clearAgentRunContext(evt.runId, evt.lifecycleGeneration, evt.contextClaimId);
      return;
    }
    clearAgentRunContext(evt.runId);
  };
  const resolveEventSession = (evt: AgentEventRuntimePayload) => {
    const chatLink = evt.contextClaimId ? undefined : chatRunState.registry.peek(evt.runId);
    const sessionAgentId = chatLink?.agentId ?? evt.agentId;
    const eventSessionKey =
      evt.deliverySessionKey ??
      (typeof evt.sessionKey === "string" && evt.sessionKey.trim() ? evt.sessionKey : undefined);
    const sessionKey =
      chatLink?.sessionKey ??
      eventSessionKey ??
      getAgentRunContext(evt.runId)?.sessionKey ??
      resolveSessionKeyForRun(evt.runId, sessionAgentId ? { agentId: sessionAgentId } : undefined);
    return { chatLink, sessionAgentId, eventSessionKey, sessionKey };
  };

  type TerminalLifecycleOptions = {
    publishLifecycle?: boolean;
    skipChatErrorFinal?: boolean;
    suppressRestartRecoveryProjection?: boolean;
    restartRecoveryState?: { suppress: boolean };
  };
  type PendingTerminalLifecycleError = {
    timer: NodeJS.Timeout;
    event: AgentEventRuntimePayload;
    opts?: TerminalLifecycleOptions;
  };

  const pendingTerminalLifecycleErrors = new Map<string, PendingTerminalLifecycleError>();

  const clearPendingTerminalLifecycleError = (runId: string, lifecycleGeneration?: string) => {
    const pending = pendingTerminalLifecycleErrors.get(runId);
    if (!pending) {
      return;
    }
    if (
      lifecycleGeneration &&
      pending.event.lifecycleGeneration &&
      lifecycleGeneration !== pending.event.lifecycleGeneration
    ) {
      return;
    }
    clearTimeout(pending.timer);
    pendingTerminalLifecycleErrors.delete(runId);
  };

  const resolveSpawnedBy = (sessionKey: string): string | null => {
    const parsed = parseAgentSessionKey(sessionKey);
    const isDashboardSession = parsed?.rest.startsWith("dashboard:") === true;
    if (!isSubagentSessionKey(sessionKey) && !isAcpSessionKey(sessionKey) && !isDashboardSession) {
      return null;
    }
    const agentId =
      parsed?.agentId ?? tryResolveSessionCompatibilityOwnerAgentId(getRuntimeConfig(), sessionKey);
    return agentId
      ? (getSessionRowProjection?.()?.readPreparedSpawnedBy({ key: sessionKey, agentId }) ?? null)
      : null;
  };

  const sessionLifecyclePublisher = createSessionLifecyclePublisher({
    broadcastToConnIds,
    sessionEventSubscribers,
    getSessionRowProjection,
    persistGatewaySessionLifecycleEventForEvent,
    loadGatewaySessionLifecycleSnapshotForEvent,
    resolveSessionActiveRunState,
  });
  const buildSessionEventSnapshot = sessionLifecyclePublisher.buildSnapshot;

  const resolveSessionDeliveryKeys = (sessionKey: string, agentId?: string) => {
    if (sessionKey.trim().toLowerCase() !== "global") {
      return [sessionKey];
    }
    const compatibilityOwnerAgentId = tryResolveSessionCompatibilityOwnerAgentId(
      getRuntimeConfig(),
      sessionKey,
    );
    const deliveryAgentId = agentId ?? compatibilityOwnerAgentId;
    return deliveryAgentId
      ? resolveSessionSubscriptionKeys(sessionKey, deliveryAgentId, compatibilityOwnerAgentId)
      : [];
  };
  const emitFirstAssistantChatSendTiming = (chatLink: ChatRunEntry | undefined) => {
    const timing = chatLink?.chatSendTiming;
    if (!timing || timing.firstAssistantEventSent) {
      return;
    }
    timing.firstAssistantEventSent = true;
    const nowMs = performance.now();
    broadcastToConnIds(
      "chat.send_timing",
      {
        phase: "first-assistant-event",
        runId: chatLink.clientRunId,
        sessionKey: chatLink.sessionKey,
        ...(chatLink.agentId ? { agentId: chatLink.agentId } : {}),
        ackToPhaseMs: roundedChatSendTimingMs(nowMs - timing.ackedAtMs),
        receivedToPhaseMs: roundedChatSendTimingMs(nowMs - timing.receivedAtMs),
        ...(timing.dispatchStartedAtMs !== undefined
          ? {
              dispatchStartedToPhaseMs: roundedChatSendTimingMs(nowMs - timing.dispatchStartedAtMs),
            }
          : {}),
      },
      new Set([timing.connId]),
      { dropIfSlow: true },
    );
  };

  const finalizeLifecycleEvent = (
    evt: AgentEventRuntimePayload,
    opts?: TerminalLifecycleOptions,
  ) => {
    if (!shouldProcessOwnedEvent(evt.runId, evt.contextClaimId, evt.lifecycleGeneration)) {
      return;
    }
    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : null;
    if (lifecyclePhase !== "end" && lifecyclePhase !== "error") {
      return;
    }

    const currentRunContext = getAgentRunContext(evt.runId);
    const activeLifecycleGeneration = resolveActiveLifecycleGenerationForRun(evt.runId);
    const currentLifecycleGeneration =
      activeLifecycleGeneration ?? currentRunContext?.lifecycleGeneration;

    const { chatLink, sessionAgentId, sessionKey } = resolveEventSession(evt);
    const isControlUiVisible =
      evt.controlUiVisible ?? currentRunContext?.isControlUiVisible ?? true;
    const projectSessionLifecycle =
      evt.projectSessionLifecycle ?? currentRunContext?.projectSessionLifecycle ?? true;
    const projectSessionMessages =
      evt.projectSessionMessages ?? currentRunContext?.projectSessionMessages ?? true;
    const clientRunId = chatLink?.clientRunId ?? evt.runId;
    const isAborted =
      isChatAbortMarkerCurrent(chatRunState.runs.get(clientRunId)?.abortMarker, chatLink) ||
      isChatAbortMarkerCurrent(chatRunState.runs.get(evt.runId)?.abortMarker, chatLink);
    const lifecycleAborted = evt.data?.aborted === true;
    const replyDispatchOwnsCompletion = evt.data?.completionSource === "reply-dispatch";
    const deliverySessionKeys = sessionKey
      ? resolveSessionDeliveryKeys(sessionKey, sessionAgentId)
      : [];
    const suppressRestartRecoveryProjection =
      opts?.suppressRestartRecoveryProjection === true ||
      Boolean(
        evt.lifecycleGeneration &&
        activeLifecycleGeneration &&
        evt.lifecycleGeneration !== activeLifecycleGeneration,
      ) ||
      opts?.restartRecoveryState?.suppress === true;
    const isSupersededRestartRecoveryEvent =
      suppressRestartRecoveryProjection &&
      Boolean(
        evt.lifecycleGeneration &&
        currentLifecycleGeneration &&
        evt.lifecycleGeneration !== currentLifecycleGeneration,
      );
    if (isSupersededRestartRecoveryEvent) {
      return;
    }
    clearPendingTerminalLifecycleError(evt.runId, evt.lifecycleGeneration);
    const terminalPersistence =
      sessionKey && !suppressRestartRecoveryProjection && projectSessionLifecycle
        ? persistGatewaySessionLifecycleEventForEvent({
            sessionKey,
            agentId: sessionAgentId,
            event: {
              ...evt,
              ...(evt.contextClaimId ? { contextClaimId: evt.contextClaimId } : {}),
              ...(clientRunId !== evt.runId ? { clientRunId } : {}),
              ...(evt.lifecycleGeneration ? { lifecycleGeneration: evt.lifecycleGeneration } : {}),
              ...(evt.mainSessionRestartRecovery === true
                ? { mainSessionRestartRecovery: true as const }
                : {}),
            },
          })
        : undefined;
    // Completion retires the registration even when no visible terminal is published.
    // The peeked head is still current in this synchronous frame; delivery-owned runs wait.
    const finished =
      chatLink && !replyDispatchOwnsCompletion ? chatRunState.registry.shift(evt.runId) : undefined;

    if (
      opts?.publishLifecycle !== false &&
      !replyDispatchOwnsCompletion &&
      !suppressRestartRecoveryProjection &&
      sessionKey &&
      (isControlUiVisible ||
        (projectSessionMessages &&
          deliverySessionKeys.some(
            (deliverySessionKey) => sessionMessageSubscribers.get(deliverySessionKey).size > 0,
          )))
    ) {
      if (!isAborted) {
        const terminalSessionKey = finished?.sessionKey ?? sessionKey;
        const terminalRunId = finished?.clientRunId ?? clientRunId;
        const terminalAgentId = finished?.agentId ?? sessionAgentId;
        const terminalOutcome = buildAgentRunTerminalOutcomeFromLifecycleEvent({
          phase: lifecyclePhase,
          data: evt.data,
          endedAt: evt.data?.endedAt ?? evt.ts,
        });
        const yieldedWaiting = isAgentLifecycleYieldedWaiting({
          phase: lifecyclePhase,
          yielded: evt.data?.yielded,
          livenessState: evt.data?.livenessState,
          stopReason: terminalOutcome.stopReason,
          aborted: lifecycleAborted,
          status: evt.data?.status,
          timeoutPhase: evt.data?.timeoutPhase,
          error: evt.data?.error,
        });
        const terminalClassification = classifyAgentRunTerminalOutcome(terminalOutcome);
        const terminalState = CHAT_STATE_BY_TERMINAL_CLASSIFICATION[terminalClassification];
        if (!(opts?.skipChatErrorFinal && terminalState === "error")) {
          emitChatTerminal(
            {
              sessionKey: terminalSessionKey,
              clientRunId: terminalRunId,
              sourceRunId: evt.runId,
              seq: evt.seq,
              agentId: terminalAgentId,
              controlUiVisible: isControlUiVisible,
              isHeartbeat: resolveHeartbeatFlag(clientRunId, evt.runId, evt.isHeartbeat),
              firstAssistantTimingEntry: finished,
            },
            terminalState,
            terminalOutcome.error ?? evt.data?.error,
            terminalOutcome.stopReason,
            // Timeout is a recorded classification, not event metadata: the
            // lifecycle producer emits no errorKind, so without this the UI
            // shows a generic "failed" while sessions.list says "timeout".
            terminalClassification === "timeout"
              ? "timeout"
              : (readChatErrorKind(evt.data?.errorKind) ??
                  resolveChatErrorKindFromError(evt.data?.error)),
            {
              abortErrorMessage: readToolValidationErrorSummary(evt.data?.toolErrorSummary),
              yielded: yieldedWaiting ? true : undefined,
              errorObservation: evt.data?.errorObservation,
              assistantTranscriptIdempotencyKey: readStringValue(
                evt.data?.assistantTranscriptIdempotencyKey,
              ),
              terminalPersistence,
              isCurrent: () =>
                shouldProcessOwnedEvent(evt.runId, evt.contextClaimId, evt.lifecycleGeneration),
            },
          );
        }
      }
    }

    toolEventRecipients.markFinal(evt.runId);
    // Payload dispatch owns its chat terminal and registration until delivery
    // settles; lifecycle observers still receive the runtime's terminal below.
    if (!replyDispatchOwnsCompletion) {
      chatRunState.clearRun(clientRunId);
      if (!evt.contextClaimId) {
        clearRunContextForEvent(evt);
      }
      agentRunSeq.delete(evt.runId);
      agentRunSeq.delete(clientRunId);
    }

    if (sessionKey) {
      clearTrackedActiveRun?.({ runId: evt.runId, clientRunId, sessionKey });
      if (terminalPersistence) {
        const projection = getSessionRowProjection?.();
        trackTrackedRunTerminalPersistence?.({
          runId: evt.runId,
          clientRunId,
          sessionKey,
          sessionId: evt.sessionId,
          persistence: terminalPersistence,
        });
        sessionLifecyclePublisher.publish({
          event: evt,
          phase: lifecyclePhase,
          sessionKey,
          agentId: sessionAgentId,
          clientRunId,
          persistence: terminalPersistence,
          projection,
          publishLifecycle: opts?.publishLifecycle,
        });
      } else {
        settleTrackedTerminal?.({
          runId: evt.runId,
          clientRunId,
          sessionKey,
        });
      }
    }
    if (!replyDispatchOwnsCompletion && evt.contextClaimId) {
      // The queued write's commit guard requires this exact claim to stay active.
      // Abort or replacement can still revoke it before the write settles.
      if (terminalPersistence) {
        const clearOwnedRunContext = () => clearRunContextForEvent(evt);
        void terminalPersistence.then(clearOwnedRunContext, clearOwnedRunContext);
      } else {
        clearRunContextForEvent(evt);
      }
    }
  };

  const scheduleTerminalLifecycleError = (
    evt: AgentEventRuntimePayload,
    opts?: TerminalLifecycleOptions,
  ) => {
    clearPendingTerminalLifecycleError(evt.runId);
    const timer = setSafeTimeout(() => {
      const pending = pendingTerminalLifecycleErrors.get(evt.runId);
      if (!pending || pending.timer !== timer) {
        return;
      }
      pendingTerminalLifecycleErrors.delete(evt.runId);
      finalizeLifecycleEvent(pending.event, pending.opts);
    }, lifecycleErrorRetryGraceMs);
    timer.unref?.();
    pendingTerminalLifecycleErrors.set(evt.runId, { timer, event: evt, opts });
  };

  const broadcastChatDelta = (delivery: ChatDelivery, text: string) => {
    const { sessionKey, agentId, clientRunId, sourceRunId, seq } = delivery;
    cancelPendingLiveTextFlush(chatRunState.runs.get(clientRunId), "chat");
    const run = chatRunState.getOrCreate(clientRunId);
    if (
      transcriptPublication.holdDelta(clientRunId, () =>
        flushBufferedChatDeltaIfNeeded({
          ...delivery,
          seq: agentRunSeq.get(sourceRunId) ?? seq,
        }),
      )
    ) {
      return;
    }
    const broadcastDelta = chatRunState.takeBufferDelta(clientRunId, text);
    if (!broadcastDelta) {
      return;
    }
    const now = Date.now();
    run.deltaSentAt = now;
    const spawnedBy = resolveSpawnedBy(sessionKey);
    const deliveryKey = JSON.stringify([
      "chat",
      sessionKey,
      agentId,
      delivery.controlUiVisible ?? true,
    ]);
    const canvasBlocks = run.canvasBlocks;
    const payload = {
      runId: clientRunId,
      sessionKey,
      ...(agentId ? { agentId } : {}),
      ...(spawnedBy && { spawnedBy }),
      seq,
      state: "delta" as const,
      ...broadcastDelta,
      message: appendChatCanvasBlocksToMessage(
        { role: "assistant", content: [{ type: "text", text }], timestamp: now },
        canvasBlocks ?? [],
      ),
    };
    emitFirstAssistantChatSendTiming(
      delivery.firstAssistantTimingEntry ?? chatRunState.registry.peek(sourceRunId),
    );
    sendLivePayload("chat", sessionKey, payload, {
      agentId,
      controlUiVisible: delivery.controlUiVisible ?? true,
      dropIfSlow: true,
      liveText: liveTextDelivery(
        chatRunState,
        clientRunId,
        broadcastDelta.replace
          ? undefined
          : {
              key: deliveryKey,
              merge: mergeChatTextPayload,
            },
        run.bufferIsCurrent,
        chatWireProjection({
          key: deliveryKey,
          text,
          now,
          canvasBlocks,
          replace: broadcastDelta.replace,
        }),
      ),
    });
  };

  const broadcastBufferedChatDelta = (
    delivery: ChatDelivery,
    heartbeatForFilter = delivery.isHeartbeat,
  ) => {
    const { clientRunId, sourceRunId } = delivery;
    const { text, suppress } = chatRunState.resolveBuffer(clientRunId);
    if (!shouldHideHeartbeatChatOutput(clientRunId, sourceRunId, heartbeatForFilter)) {
      // Suppression retracts a prior visible snapshot; omission would leave stale text.
      broadcastChatDelta(delivery, suppress ? "" : text);
    }
  };

  const emitChatDelta = (
    delivery: ChatDelivery,
    input: NonNullable<ReturnType<typeof resolveAssistantTextInput>>,
    source: AgentEventRuntimePayload["assistantSource"],
    isCurrent?: () => boolean,
  ) => {
    const { clientRunId, sourceRunId } = delivery;
    const run = chatRunState.getOrCreate(clientRunId);
    const previousRawText = run.rawBuffer ?? "";
    const mergedRawText = chatRunState.updateBuffer(clientRunId, input, source);
    if (!mergedRawText && !previousRawText) {
      return;
    }
    const now = Date.now();
    run.bufferIsCurrent = isCurrent;
    if (!mergedRawText) {
      broadcastChatDelta(delivery, "");
      return;
    }
    if (run.deltaSentAt !== undefined && !input.replace) {
      scheduleLiveTextFlush(run, "chat", LIVE_TEXT_PACING_MS - (now - run.deltaSentAt), () => {
        if (run.bufferIsCurrent?.() === false) {
          chatRunState.clearRun(clientRunId);
          agentRunSeq.delete(sourceRunId);
          return;
        }
        broadcastBufferedChatDelta({ ...delivery, isHeartbeat: undefined }, delivery.isHeartbeat);
      });
      return;
    }
    broadcastBufferedChatDelta(delivery);
  };

  const flushBufferedChatDeltaIfNeeded = (delivery: ChatDelivery) => {
    cancelPendingLiveTextFlush(chatRunState.runs.get(delivery.clientRunId), "chat");
    broadcastBufferedChatDelta(delivery);
  };

  const transcriptPublication = createChatTranscriptPublication({
    chatRunState,
    agentRunSeq,
    flush: (sessionKey, agentId, clientRunId, sourceRunId, seq, options) =>
      flushBufferedChatDeltaIfNeeded({
        sessionKey,
        agentId,
        clientRunId,
        sourceRunId,
        seq,
        ...options,
      }),
  });

  const sendLivePayload = (
    event: "agent" | "chat",
    sessionKey: string | undefined,
    payload: ChatEvent | AgentEventPayload,
    opts?: LivePayloadOptions,
  ) => {
    if (
      event === "chat" &&
      "state" in payload &&
      (payload.state === "final" || payload.state === "error" || payload.state === "aborted") &&
      transcriptPublication.holdTerminal(payload.runId, () =>
        sendLivePayload(event, sessionKey, payload, opts),
      )
    ) {
      return;
    }
    const visible = opts?.controlUiVisible ?? true;
    const deliverySessionKeys = sessionKey
      ? resolveSessionDeliveryKeys(sessionKey, opts?.agentId)
      : undefined;
    const liveText = opts?.liveText ?? liveTextDelivery(chatRunState, payload.runId);
    const broadcastOpts: GatewayBroadcastOpts = {
      dropIfSlow: event === "agent" && visible ? undefined : opts?.dropIfSlow,
      excludeClientCapability:
        event === "agent" &&
        "stream" in payload &&
        payload.stream === "assistant" &&
        (typeof payload.data.text === "string" || typeof payload.data.delta === "string")
          ? GATEWAY_CLIENT_CAPS.CHAT_ONLY_ASSISTANT_TEXT
          : undefined,
      sessionKeys: deliverySessionKeys,
      liveText:
        liveText &&
        event === "chat" &&
        "state" in payload &&
        (payload.state === "final" || payload.state === "error")
          ? { ...liveText, settle: true }
          : liveText,
    };
    if (visible) {
      broadcast(event, payload, broadcastOpts);
      if (deliverySessionKeys?.[0]) {
        nodeSendToSession(deliverySessionKeys[0], event, payload, broadcastOpts);
      }
      return;
    }
    const recipients = new Set<string>();
    for (const deliveryKey of deliverySessionKeys ?? []) {
      for (const connId of sessionMessageSubscribers.get(deliveryKey)) {
        recipients.add(connId);
      }
    }
    if (recipients.size > 0) {
      // Queued progress carries no session row; hydrate only after pacing and
      // current subscription selection, using the captured event's owner.
      const deliveredPayload =
        event === "agent" && sessionKey
          ? { ...payload, ...buildSessionEventSnapshot(sessionKey, undefined, opts?.agentId) }
          : payload;
      broadcastToConnIds(event, deliveredPayload, recipients, {
        ...broadcastOpts,
        sessionSubscriptionVerified: true,
      });
    }
  };

  const emitChatTerminal = (
    delivery: ChatDelivery,
    jobState: "done" | "error" | "aborted",
    error?: unknown,
    stopReason?: string,
    errorKind?: ChatErrorKind,
    opts?: {
      abortErrorMessage?: string;
      yielded?: true;
      errorObservation?: unknown;
      assistantTranscriptIdempotencyKey?: string;
      terminalPersistence?: Promise<void>;
      isCurrent?: () => boolean;
    },
  ) => {
    const { sessionKey, clientRunId, sourceRunId, seq, agentId } = delivery;
    const terminalBuffer = chatRunState.resolveBuffer(clientRunId, { final: true });
    const normalizedHeartbeatText = normalizeHeartbeatChatFinalText({
      runId: clientRunId,
      sourceRunId,
      text: terminalBuffer.text.trim(),
      isHeartbeat: delivery.isHeartbeat,
    });
    const projected = projectLiveAssistantBufferedText(normalizedHeartbeatText.text.trim(), {
      suppressLeadFragments: false,
    });
    const text = projected.text.trim();
    const shouldSuppressSilent =
      normalizedHeartbeatText.suppress || (projected.suppress && !terminalBuffer.displayText);
    const hasDisplayContent = Boolean(text || terminalBuffer.displayText);
    // Flush any paced delta so streaming clients receive the complete text
    // before the final event.
    // Only flush if the buffered text differs from the last broadcast to avoid duplicates.
    flushBufferedChatDeltaIfNeeded(delivery);
    const spawnedBy = resolveSpawnedBy(sessionKey);
    const terminalPayload = {
      runId: clientRunId,
      sessionKey,
      ...(agentId ? { agentId } : {}),
      ...(spawnedBy && { spawnedBy }),
      seq,
    };
    const createTerminalMessage = (canvasBlocks: NonNullable<ChatRunRecord["canvasBlocks"]>) =>
      appendChatCanvasBlocksToMessage(
        {
          role: "assistant",
          content: text ? [{ type: "text", text }] : [],
          timestamp: Date.now(),
          ...(terminalBuffer.displayText === undefined
            ? {}
            : {
                [ASSISTANT_DISPLAY_CONTENT_FIELD]: appendChatCanvasBlocks(
                  terminalBuffer.displayText
                    ? [{ type: "text", text: terminalBuffer.displayText }]
                    : [],
                  canvasBlocks,
                ),
              }),
          ...(opts?.assistantTranscriptIdempotencyKey
            ? {
                __openclaw: {
                  runId: clientRunId,
                  idempotencyKey: opts.assistantTranscriptIdempotencyKey,
                },
              }
            : {}),
        },
        canvasBlocks,
      );
    if (jobState !== "error") {
      const run = chatRunState.runs.get(clientRunId);
      const canvasBlocks = run?.canvasBlocks ?? [];
      // Empty tool-only turns can render widgets; explicit silent/control replies
      // still suppress their message, even when an earlier tool hosted a widget.
      const canvasOnly =
        jobState === "done" &&
        canvasBlocks.length > 0 &&
        !(run?.rawBuffer ?? run?.buffer ?? "").trim();
      const payload = {
        ...terminalPayload,
        state: jobState === "done" ? ("final" as const) : ("aborted" as const),
        ...(jobState === "aborted" && opts?.abortErrorMessage
          ? { errorMessage: opts.abortErrorMessage }
          : {}),
        ...(stopReason && { stopReason }),
        ...(jobState === "done" && opts?.yielded ? { yielded: true as const } : {}),
        message:
          (hasDisplayContent && !shouldSuppressSilent) || canvasOnly
            ? createTerminalMessage(canvasBlocks)
            : undefined,
      };
      if (payload.message) {
        emitFirstAssistantChatSendTiming(delivery.firstAssistantTimingEntry);
      }
      sendLivePayload("chat", sessionKey, payload, delivery);
      chatRunState.clearRun(clientRunId);
      return;
    }
    const errorDetail = projectChatErrorDetail(opts?.errorObservation);
    const payload = {
      ...terminalPayload,
      state: "error" as const,
      ...(opts?.assistantTranscriptIdempotencyKey && hasDisplayContent && !shouldSuppressSilent
        ? {
            message: createTerminalMessage(chatRunState.runs.get(clientRunId)?.canvasBlocks ?? []),
          }
        : {}),
      errorMessage: renderChatRunError(error),
      ...(errorKind && { errorKind }),
      ...(errorDetail ? { errorDetail } : {}),
      ...(stopReason && { stopReason }),
    };
    const publish = () => {
      if (opts?.isCurrent?.() !== false) {
        sendLivePayload("chat", sessionKey, payload, delivery);
      }
    };
    // A terminal error must not outrun its durable failure notice. Other finals
    // keep their synchronous delivery; a failed write still exposes the run error.
    if (opts?.terminalPersistence) {
      void opts.terminalPersistence.then(publish, publish).catch((publicationError: unknown) => {
        logError(
          `gateway: terminal chat publication failed: ${formatErrorMessage(publicationError)}`,
        );
      });
    } else {
      publish();
    }
    chatRunState.clearRun(clientRunId);
  };

  const sendAgentPayload = (
    sessionKey: string | undefined,
    payload: AgentEventPayload & { spawnedBy?: string },
    opts?: LivePayloadOptions & { coalesce?: boolean; isCurrent?: () => boolean; settle?: true },
  ) => {
    const stream = resolveAgentTextThrottleStream(payload);
    const deliveryKey = JSON.stringify([
      "agent",
      stream,
      payload.data.itemId,
      sessionKey,
      opts?.agentId,
      opts?.controlUiVisible ?? true,
    ]);
    const liveText = liveTextDelivery(
      chatRunState,
      payload.runId,
      stream && opts?.coalesce
        ? {
            key: deliveryKey,
            merge: mergeAgentTextPayload,
          }
        : undefined,
      opts?.isCurrent,
      assistantWireProjection(payload, sessionKey, opts?.agentId, opts?.controlUiVisible ?? true),
    );
    if (liveText && opts?.settle) {
      liveText.settle = true;
    }
    sendLivePayload("agent", sessionKey, payload, { ...opts, liveText });
  };

  const flushBufferedAgentDeltaIfNeeded = (clientRunId: string) => {
    const run = chatRunState.runs.get(clientRunId);
    cancelPendingLiveTextFlush(run, "agent");
    const states = Object.values(run?.agentText ?? {});
    states.sort(
      (a, b) => (a.bufferedEvent?.payload.seq ?? 0) - (b.bufferedEvent?.payload.seq ?? 0),
    );
    for (const state of states) {
      const buffered = state.bufferedEvent;
      if (!buffered) {
        continue;
      }
      delete state.bufferedEvent;
      if (buffered.isCurrent?.() === false) {
        continue;
      }
      state.lastSentAt = Date.now();
      sendAgentPayload(buffered.sessionKey, buffered.payload, {
        agentId: buffered.agentId,
        controlUiVisible: buffered.controlUiVisible,
        dropIfSlow: buffered.controlUiVisible === false,
        coalesce: true,
        isCurrent: buffered.isCurrent,
      });
    }
  };

  const resolveAgentTextThrottleStream = (
    evt: AgentEventPayload,
  ): AgentTextThrottleStream | null => {
    if (evt.stream === "assistant" || evt.stream === "thinking") {
      const stream = evt.stream === "assistant" ? "assistant" : "thinking";
      return typeof evt.data.delta === "string" || evt.data.replace === true ? stream : null;
    }
    const { kind, phase, status, itemId, progressText } = evt.data;
    // Growing previews share text pacing; completion and selection remain ordering barriers.
    return evt.stream === "item" &&
      phase === "update" &&
      (kind === "preamble" || (kind === "answer_candidate" && status === "candidate")) &&
      typeof itemId === "string" &&
      typeof progressText === "string"
      ? kind
      : null;
  };

  const shouldCoalesceAgentTextEvent = (evt: AgentEventPayload) =>
    !(Array.isArray(evt.data.mediaUrls) && evt.data.mediaUrls.length > 0) &&
    typeof evt.data.mediaUrl !== "string" &&
    evt.data.replace !== true &&
    (evt.stream === "item" ||
      (typeof evt.data.text === "string" &&
        typeof evt.data.delta === "string" &&
        evt.data.delta.length > 0 &&
        (evt.stream !== "assistant" || !shouldSuppressAssistantEventForLiveChat(evt.data))));

  const sendOrBufferAgentTextEvent = (
    clientRunId: string,
    next: BufferedAgentEvent,
    settle?: true,
  ) => {
    const { payload } = next;
    const stream = resolveAgentTextThrottleStream(payload);
    const now = Date.now();
    const run = stream ? chatRunState.getOrCreate(clientRunId) : undefined;
    const state = run && stream ? ((run.agentText ??= {})[stream] ??= {}) : undefined;
    const last = state?.lastSentAt;
    const previous = state?.bufferedEvent;
    // Even an overdue wake owns delivery; flushing on ingress defeats batching
    // while a busy event loop is still draining provider notifications.
    if (
      run &&
      state &&
      last !== undefined &&
      shouldCoalesceAgentTextEvent(payload) &&
      (!previous ||
        (previous.payload.data.itemId === payload.data.itemId &&
          previous.sessionKey === next.sessionKey &&
          previous.agentId === next.agentId &&
          previous.controlUiVisible === next.controlUiVisible &&
          previous.isCurrent?.() !== false))
    ) {
      // Deltas accumulate, while item progress replaces its cumulative snapshot.
      state.bufferedEvent = {
        ...next,
        payload: previous ? mergeAgentTextPayload(previous.payload, payload) : payload,
      };
      scheduleLiveTextFlush(run, "agent", LIVE_TEXT_PACING_MS - (now - last), () =>
        flushBufferedAgentDeltaIfNeeded(clientRunId),
      );
      return;
    }
    flushBufferedAgentDeltaIfNeeded(clientRunId);
    sendAgentPayload(next.sessionKey, payload, {
      agentId: next.agentId,
      controlUiVisible: next.controlUiVisible,
      dropIfSlow: next.controlUiVisible === false,
      isCurrent: next.isCurrent,
      settle,
    });
    if (state) {
      state.lastSentAt = now;
    }
  };

  const resolveToolVerboseLevel = (
    event: AgentEventRuntimePayload,
    sessionKey: string,
    agentId: string | undefined,
  ) => {
    const runContext = getAgentRunContext(event.runId);
    const runVerbose = normalizeVerboseLevel(runContext?.verboseLevel ?? event.verboseLevel);
    const registeredAt = runContext?.registeredAt ?? event.registeredAt;
    try {
      const { cfg, entry } = loadGatewaySessionEntryReadOnly(sessionKey, { agentId, clone: false });
      const sessionVerbose = normalizeVerboseLevel(entry?.verboseLevel);
      const sessionUpdatedAt = typeof entry?.updatedAt === "number" ? entry.updatedAt : undefined;
      const sessionChangedAfterRunStarted =
        sessionUpdatedAt !== undefined &&
        registeredAt !== undefined &&
        sessionUpdatedAt >= registeredAt;
      if (sessionVerbose && (!runVerbose || sessionChangedAfterRunStarted)) {
        return sessionVerbose;
      }
      if (runVerbose) {
        return runVerbose;
      }
      const defaultVerbose = normalizeVerboseLevel(cfg.agents?.defaults?.verboseDefault);
      return defaultVerbose ?? "off";
    } catch {
      return runVerbose ?? "off";
    }
  };

  const sendNodeToolPayload = (
    event: AgentEventRuntimePayload,
    sessionKey: string,
    agentId: string | undefined,
    payload: AgentEventPayload,
  ) => {
    const deliveryKeys = resolveSessionDeliveryKeys(sessionKey, agentId).filter(
      nodeHasSessionSubscribers,
    );
    const firstDeliveryKey = deliveryKeys[0];
    if (!firstDeliveryKey) {
      return;
    }
    const verbose = resolveToolVerboseLevel(event, sessionKey, agentId);
    if (verbose === "off") {
      return;
    }
    let channelPayload = payload;
    if (verbose !== "full") {
      const data = { ...event.data };
      delete data.result;
      delete data.partialResult;
      channelPayload = { ...payload, data };
    }
    const nodePayload = {
      ...channelPayload,
      ...buildSessionEventSnapshot(sessionKey, undefined, agentId),
    };
    // Registration is demand only; each send still validates its pairing generation.
    nodeSendToSession(firstDeliveryKey, "agent", nodePayload, { sessionKeys: deliveryKeys });
  };

  const handleEvent = (event: AgentEventPayload, restartRecoveryState?: { suppress: boolean }) => {
    const evt = event as AgentEventRuntimePayload;
    const isCurrent = shouldProcessOwnedEvent.bind(
      null,
      evt.runId,
      evt.contextClaimId,
      evt.lifecycleGeneration,
    );
    if (!isCurrent()) {
      return;
    }
    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : null;

    const { chatLink, sessionAgentId, sessionKey } = resolveEventSession(evt);
    const runContext = getAgentRunContext(evt.runId);
    const activeLifecycleGeneration = resolveActiveLifecycleGenerationForRun(evt.runId);
    const isControlUiVisible = evt.controlUiVisible ?? runContext?.isControlUiVisible ?? true;
    const projectSessionLifecycle =
      evt.projectSessionLifecycle ?? runContext?.projectSessionLifecycle ?? true;
    const projectSessionMessages =
      evt.projectSessionMessages ?? runContext?.projectSessionMessages ?? true;
    const clientRunId = chatLink?.clientRunId ?? evt.runId;
    const isHeartbeat = runContext?.isHeartbeat ?? evt.isHeartbeat;
    const heartbeatPolicy = resolveHeartbeatFlag(clientRunId, evt.runId, evt.isHeartbeat);
    const chatDelivery = sessionKey
      ? {
          sessionKey,
          agentId: sessionAgentId,
          clientRunId,
          sourceRunId: evt.runId,
          seq: evt.seq,
          controlUiVisible: isControlUiVisible,
        }
      : undefined;
    transcriptPublication.observeAgentEvent(evt, clientRunId, isCurrent);
    const eventForClients = prepareAgentWirePayload(evt, clientRunId, chatRunState, isCurrent);
    const isAborted =
      isChatAbortMarkerCurrent(chatRunState.runs.get(clientRunId)?.abortMarker, chatLink) ||
      isChatAbortMarkerCurrent(chatRunState.runs.get(evt.runId)?.abortMarker, chatLink);
    const recordsEmbeddedProgress = !chatLink && isActiveEmbeddedRunId(evt.runId);
    const recordsInFlightProgress =
      (Boolean(chatLink) && isControlUiVisible) || recordsEmbeddedProgress;

    const suppressRestartRecoveryLifecycle =
      lifecyclePhase !== null &&
      (Boolean(
        evt.lifecycleGeneration &&
        activeLifecycleGeneration &&
        evt.lifecycleGeneration !== activeLifecycleGeneration,
      ) ||
        restartRecoveryState?.suppress === true);
    if (suppressRestartRecoveryLifecycle) {
      clearPendingTerminalLifecycleError(evt.runId, evt.lifecycleGeneration);
      if (lifecyclePhase === "end" || lifecyclePhase === "error") {
        finalizeLifecycleEvent(evt, {
          suppressRestartRecoveryProjection: true,
          restartRecoveryState,
        });
      }
      return;
    }
    if (lifecyclePhase !== null && lifecyclePhase !== "error") {
      clearPendingTerminalLifecycleError(evt.runId);
    }
    const publishLifecycle = evt.admitLifecyclePublication?.() ?? true;

    // Include sessionKey so Control UI can filter tool streams per session.
    const spawnedBy = sessionKey ? resolveSpawnedBy(sessionKey) : null;
    const agentPayload = {
      ...eventForClients,
      ...(sessionKey
        ? {
            sessionKey,
            ...(sessionAgentId ? { agentId: sessionAgentId } : {}),
            ...(spawnedBy && { spawnedBy }),
          }
        : {}),
      ...(isHeartbeat !== undefined && { isHeartbeat }),
    };
    const hasSessionMessageSubscribers =
      projectSessionMessages && sessionKey
        ? resolveSessionDeliveryKeys(sessionKey, sessionAgentId).some(
            (deliverySessionKey) => sessionMessageSubscribers.get(deliverySessionKey).size > 0,
          )
        : false;
    const last = agentRunSeq.get(evt.runId) ?? 0;
    const isToolEvent = evt.stream === "tool";
    const isItemEvent = evt.stream === "item";
    const suppressHeartbeatToolEvents = isToolEvent && heartbeatPolicy === true;
    if (publishLifecycle && last > 0 && evt.seq !== last + 1) {
      flushBufferedAgentDeltaIfNeeded(clientRunId);
      if (isControlUiVisible) {
        broadcast(
          "agent",
          {
            runId: clientRunId,
            stream: "error",
            ts: Date.now(),
            sessionKey,
            ...(spawnedBy && { spawnedBy }),
            ...(isHeartbeat !== undefined && { isHeartbeat }),
            data: {
              reason: "seq gap",
              expected: last + 1,
              received: evt.seq,
            },
          },
          {
            sessionKeys: sessionKey
              ? resolveSessionDeliveryKeys(sessionKey, sessionAgentId)
              : undefined,
            liveText: liveTextDelivery(chatRunState, clientRunId),
          },
        );
      }
      const run = chatRunState.runs.get(clientRunId);
      if (run) {
        run.liveTextEpoch = {};
      }
    }
    agentRunSeq.set(evt.runId, evt.seq);
    if (evt.stream === "assistant") {
      updateRunToolErrorSummary?.({ runId: evt.runId, clientRunId, summary: undefined });
    }
    if (evt.stream === "plan" && evt.data?.phase === "update") {
      const steps = normalizeAgentPlanSteps(evt.data.steps) ?? [];
      const explanation =
        typeof evt.data.explanation === "string" ? evt.data.explanation.trim() : "";
      chatRunState.getOrCreate(clientRunId).planSnapshot = {
        steps,
        ...(explanation ? { explanation } : {}),
      };
    }
    if (recordsInFlightProgress && !isAborted && !suppressHeartbeatToolEvents && publishLifecycle) {
      // Persist the client-facing identity after run/session remapping. Route
      // changes discard transient UI rows, so history replay must use the same
      // payload identity as live delivery or tool results cannot reconcile.
      chatRunState.recordProgressEvent(
        clientRunId,
        agentPayload,
        recordsEmbeddedProgress ? "summary" : "full",
      );
    }
    if (evt.stream === "run_status" && chatLink && isControlUiVisible && sessionKey && !isAborted) {
      const payload = {
        runId: clientRunId,
        sessionKey,
        ...(sessionAgentId ? { agentId: sessionAgentId } : {}),
        ...(spawnedBy && { spawnedBy }),
        seq: evt.seq,
        state: "status" as const,
        ...(evt.data.phase === "retrying"
          ? {
              phase: "starting_model",
              ...(evt.data.reason === "rate_limit"
                ? {
                    retry: {
                      attempt: evt.data.attempt,
                      maxAttempts: evt.data.maxAttempts,
                      reason: evt.data.reason,
                    },
                  }
                : {}),
            }
          : { phase: evt.data.phase }),
      };
      if (Value.Check(ChatStatusEventSchema, payload)) {
        sendLivePayload("chat", sessionKey, payload, {
          agentId: sessionAgentId,
          controlUiVisible: true,
          dropIfSlow: true,
        });
      }
    }
    const emitAssistantChatProjection = () => {
      if (!(isControlUiVisible || hasSessionMessageSubscribers) || !chatDelivery) {
        return;
      }
      const assistantLiveChatInput = evt.assistantProjection
        ? resolveAssistantTextInput({ ...evt.data, ...evt.assistantProjection })
        : evt.stream === "assistant"
          ? resolveAssistantTextInput(evt.data)
          : undefined;
      const suppressAssistant = shouldSuppressAssistantEventForLiveChat(evt.data);
      if (
        !isAborted &&
        assistantLiveChatInput &&
        (!suppressAssistant || assistantLiveChatInput.itemId)
      ) {
        emitChatDelta(
          { ...chatDelivery, isHeartbeat: heartbeatPolicy },
          suppressAssistant
            ? { ...assistantLiveChatInput, text: "", delta: "" }
            : assistantLiveChatInput,
          evt.assistantSource,
          isCurrent,
        );
      }
    };
    if (isItemEvent) {
      // Retract reclassified live text before publishing its commentary item.
      emitAssistantChatProjection();
    }
    if (isToolEvent) {
      const toolPhase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
      if (toolPhase === "start") {
        updateRunToolErrorSummary?.({ runId: evt.runId, clientRunId, summary: undefined });
      } else if (toolPhase === "result") {
        updateRunToolErrorSummary?.({
          runId: evt.runId,
          clientRunId,
          summary: readToolValidationErrorSummary(evt.data?.toolErrorSummary),
        });
      }
      // Flush pending assistant text before tool-start events so clients can
      // render complete pre-tool text above tool cards (not truncated by delta throttle).
      if (
        toolPhase === "start" &&
        (isControlUiVisible || hasSessionMessageSubscribers) &&
        chatDelivery &&
        !isAborted &&
        !suppressHeartbeatToolEvents
      ) {
        flushBufferedChatDeltaIfNeeded(chatDelivery);
        flushBufferedAgentDeltaIfNeeded(clientRunId);
      }
      // Always broadcast tool events to registered WS recipients with
      // tool-events capability, regardless of verboseLevel. The verbose
      // setting only controls whether tool details are sent as channel
      // messages to messaging surfaces (Telegram, Discord, etc.). Carry the
      // delivery key so scoped clients must also own the session subscription.
      const runToolRecipients = toolEventRecipients.get(evt.runId);
      if (
        isControlUiVisible &&
        !suppressHeartbeatToolEvents &&
        runToolRecipients &&
        runToolRecipients.size > 0
      ) {
        broadcastToConnIds(
          "agent",
          sessionKey
            ? {
                ...agentPayload,
                ...buildSessionEventSnapshot(sessionKey, undefined, sessionAgentId),
              }
            : agentPayload,
          runToolRecipients,
          {
            sessionKeys: sessionKey
              ? resolveSessionDeliveryKeys(sessionKey, sessionAgentId)
              : undefined,
            liveText: liveTextDelivery(chatRunState, clientRunId),
          },
        );
      }
      if (
        !isControlUiVisible &&
        sessionKey &&
        hasSessionMessageSubscribers &&
        !suppressHeartbeatToolEvents
      ) {
        sendAgentPayload(sessionKey, agentPayload, {
          agentId: sessionAgentId,
          controlUiVisible: false,
          dropIfSlow: true,
        });
      }
      // Session subscribers power operator UIs that attach to an existing
      // in-flight session after the run has already started. Those clients do
      // not know the runId in advance, so they cannot register as run-scoped
      // tool recipients. Mirror tool lifecycle onto a session-scoped event so
      // they can render live pending tool cards without polling history.
      if (isControlUiVisible && sessionKey && !suppressHeartbeatToolEvents) {
        const sessionSubscribers = new Set(sessionEventSubscribers.getAll());
        for (const connId of runToolRecipients ?? []) {
          sessionSubscribers.delete(connId);
        }
        if (sessionSubscribers.size > 0) {
          broadcastToConnIds(
            "session.tool",
            {
              ...agentPayload,
              ...buildSessionEventSnapshot(sessionKey, undefined, sessionAgentId),
            },
            sessionSubscribers,
            { dropIfSlow: true, liveText: liveTextDelivery(chatRunState, clientRunId) },
          );
        }
      }
    } else {
      const itemPhase = isItemEvent && typeof evt.data?.phase === "string" ? evt.data.phase : "";
      // The runtime error frame drains this text before retry cleanup retires its group.
      if (
        publishLifecycle &&
        (itemPhase === "start" ||
          (lifecyclePhase === "error" && evt.data.completionSource !== "reply-dispatch")) &&
        (isControlUiVisible || hasSessionMessageSubscribers) &&
        !isAborted
      ) {
        if (chatDelivery) {
          flushBufferedChatDeltaIfNeeded({ ...chatDelivery, isHeartbeat: heartbeatPolicy });
        }
        flushBufferedAgentDeltaIfNeeded(clientRunId);
      }
      if (
        publishLifecycle &&
        (isControlUiVisible ||
          (sessionKey &&
            hasSessionMessageSubscribers &&
            (isItemEvent ||
              evt.stream === "thinking" ||
              evt.stream === "approval" ||
              evt.stream === "lifecycle" ||
              (!isAborted &&
                evt.stream === "assistant" &&
                shouldMirrorAssistantEventToHiddenSessionMessages(evt.data)))))
      ) {
        sendOrBufferAgentTextEvent(
          clientRunId,
          {
            sessionKey,
            agentId: sessionAgentId,
            controlUiVisible: isControlUiVisible,
            payload: agentPayload,
            // The client payload loses non-enumerable ownership on spread.
            // Delayed sends must still belong to the original run claim.
            isCurrent,
          },
          lifecyclePhase === "end" && !isAborted && evt.data.aborted !== true ? true : undefined,
        );
      }
    }

    if ((isControlUiVisible || hasSessionMessageSubscribers) && sessionKey) {
      if (
        isToolEvent &&
        evt.data.phase === "result" &&
        !evt.data.isError &&
        !isAborted &&
        !suppressHeartbeatToolEvents
      ) {
        const result = extractChatToolResultCanvasPreview(evt.data.result);
        if (result?.preview.surface === "assistant_message") {
          const blocks = appendChatCanvasBlocks(
            chatRunState.runs.get(clientRunId)?.canvasBlocks ?? [],
            [{ preview: result.preview, rawText: null }],
          ).slice(-MAX_LIVE_CANVAS_BLOCKS);
          if (!boundedJsonUtf8Bytes(blocks, MAX_LIVE_CANVAS_BYTES).complete) {
            do {
              blocks.shift();
            } while (
              blocks.length > 0 &&
              !boundedJsonUtf8Bytes(blocks, MAX_LIVE_CANVAS_BYTES).complete
            );
            logWarn(
              "Live chat canvas preview omitted: display descriptors exceed the 64 KiB limit.",
            );
          }
          const run = chatRunState.getOrCreate(clientRunId);
          // Commit even an empty suffix: newer documents already consumed retention
          // slots, so keeping old handles could resurrect documents Canvas pruned.
          run.canvasBlocks = blocks;
          // Tool-only turns need the same claim retirement as buffered text.
          run.bufferIsCurrent = isCurrent;
        }
      }
      // Send tool events to node/channel subscribers only when verbose is enabled;
      // WS clients already received the event above via broadcastToConnIds.
      if (isControlUiVisible && isToolEvent && !suppressHeartbeatToolEvents) {
        sendNodeToolPayload(evt, sessionKey, sessionAgentId, agentPayload);
      }
    }
    if (!isItemEvent) {
      // Dual subscribers must receive canonical assistant text before its derived chat projection.
      emitAssistantChatProjection();
    }

    if (lifecyclePhase === "error") {
      const skipChatErrorFinal = isChatSendRunActive(evt.runId) && !chatLink;
      const definitiveTerminal = isDefinitiveRunLifecycle({
        phase: lifecyclePhase,
        data: evt.data,
      });
      // Only retryable failures get grace. Definitive cancellation and timeout
      // must persist before dispatch closes the run and the sidebar reads its status.
      if (isAborted || definitiveTerminal || lifecycleErrorRetryGraceMs <= 0) {
        // finalizeLifecycleEvent clears the buffer itself, after emitChatTerminal
        // has flushed the throttled tail and resolved the terminal message.
        finalizeLifecycleEvent(evt, { skipChatErrorFinal, publishLifecycle, restartRecoveryState });
      } else {
        if (evt.data.completionSource !== "reply-dispatch") {
          // Runtime retries isolate failed text; reply-dispatch retains its
          // post-hook payloads and abort state until its own completion settles.
          chatRunState.clearRun(clientRunId);
        }
        scheduleTerminalLifecycleError(evt, {
          skipChatErrorFinal,
          publishLifecycle,
          restartRecoveryState,
        });
      }
      return;
    }

    if (lifecyclePhase === "end") {
      finalizeLifecycleEvent(evt, { publishLifecycle, restartRecoveryState });
      return;
    }

    if (
      publishLifecycle &&
      projectSessionLifecycle &&
      sessionKey &&
      (lifecyclePhase === "start" ||
        (lifecyclePhase === "model" && runContext && isControlUiVisible))
    ) {
      sessionLifecyclePublisher.publish({
        event: evt,
        phase: lifecyclePhase,
        sessionKey,
        agentId: sessionAgentId,
        clientRunId,
        runContext,
      });
    }
  };

  const handler = createAgentEventAdmission({
    handleEvent,
    resolveEventSession,
    isCurrent: (evt) =>
      shouldProcessOwnedEvent(evt.runId, evt.contextClaimId, evt.lifecycleGeneration),
    dispose: () => {
      // Deferred provider errors cannot project into a successor subscription.
      for (const pending of pendingTerminalLifecycleErrors.values()) {
        clearTimeout(pending.timer);
      }
      pendingTerminalLifecycleErrors.clear();
    },
  });
  const dispose = handler.dispose;
  return Object.assign(handler, {
    dispose: async () => {
      await dispose();
      await transcriptPublication.drain();
    },
    retireTranscript: transcriptPublication.retireTranscript,
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
