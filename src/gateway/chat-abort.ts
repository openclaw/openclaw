import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { AGENT_RUN_TERMINAL_RETRY_GRACE_MS } from "../agents/agent-run-terminal-outcome.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
} from "../agents/run-termination.js";
import { readToolValidationErrorSummary } from "../agents/tool-error-summary.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  reserveAgentTerminalEvent,
  getAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import { registerAgentRunDeadlineRenewer } from "../infra/agent-run-deadline.js";
import {
  releaseAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { notifyGatewayWorkMetricsChanged } from "../infra/gateway-work-metrics-events.js";
import type { ChatAbortDiagnosticReason } from "./chat-abort-diagnostics.js";
import {
  markChatAbortTerminalOutcome,
  removeChatAbortControllerEntry,
} from "./chat-abort-lifecycle-internal.js";
import type { ChatAbortControllerEntry } from "./chat-abort.types.js";
import { appendChatCanvasBlocksToMessage } from "./chat-display-projection.canvas.js";
import { projectInFlightRunSnapshot, type InFlightRunSnapshot } from "./chat-inflight-snapshot.js";
import {
  renewChatRunExecutionDeadline,
  resolveAgentRunExpiresAtMs,
  resolveChatRunExpiresAtMs,
} from "./chat-run-deadline.js";
import { resolveChatRunOwnerAgentId } from "./chat-run-owner.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import { createChatAbortMarker, type ChatRunState } from "./server-chat-state.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import {
  resolveSessionSubscriptionKey,
  resolveSessionSubscriptionKeys,
} from "./session-subscription-keys.js";

export { resolveAgentRunExpiresAtMs, resolveChatRunExpiresAtMs } from "./chat-run-deadline.js";

export type { ChatAbortControllerEntry } from "./chat-abort.types.js";
export { removeChatAbortControllerEntry } from "./chat-abort-lifecycle-internal.js";

export type RestartRecoveryCandidate = {
  runId: string;
  lifecycleGeneration: string;
  sessionKey: string;
  sessionId: string;
  observedAt?: number;
};

type RegisteredChatAbortController = {
  controller: AbortController;
  markExecutionStarted: () => boolean;
  deferTimeoutCompletion: (settle: () => void) => boolean;
  bindAgentRunDelegatedAuthority: (authority: AgentRunDelegatedAuthority) => void;
  cleanup: () => void;
} & (
  | { registered: true; entry: ChatAbortControllerEntry }
  | { registered: false; entry?: undefined }
);

function createChatAbortSignalReason(stopReason: string | undefined): Error {
  if (stopReason === "restart") {
    return createAgentRunRestartAbortError();
  }
  if (stopReason !== "timeout") {
    return createAgentRunDirectAbortError();
  }
  const reason = new Error("chat run timed out");
  reason.name = "TimeoutError";
  return reason;
}

export function registerChatAbortController(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  runId: string;
  sessionId: string;
  sessionKey?: string | null;
  agentId?: string;
  timeoutMs: number;
  ownerConnId?: string;
  ownerDeviceId?: string;
  providerId?: string;
  authProviderId?: string;
  controlUiVisible?: boolean;
  projectSessionActive?: boolean;
  isAbortable?: (entry: ChatAbortControllerEntry) => boolean;
  resolveTerminalProducer?: (
    entry: ChatAbortControllerEntry,
  ) => ReturnType<NonNullable<ChatAbortControllerEntry["resolveTerminalProducer"]>>;
  onRemoved?: () => void;
  onQueueTimeout?: (entry: ChatAbortControllerEntry) => void;
  kind?: ChatAbortControllerEntry["kind"];
  turnKind?: ChatAbortControllerEntry["turnKind"];
  lifecycleGeneration?: string;
  operationalRunInstance?: OperationalRunInstanceRef;
  now?: number;
  expiresAtMs?: number;
}): RegisteredChatAbortController {
  const rawNow = params.now ?? Date.now();
  const queueDeadlineMs = resolveExpiresAtMsFromDurationMs(params.timeoutMs, { nowMs: rawNow });
  const controller = new AbortController();
  let queueTimer: ReturnType<typeof setTimeout> | undefined;
  const isStopped = (entry: ChatAbortControllerEntry) =>
    entry.registrationCleanupRequested ||
    controller.signal.aborted ||
    entry.abortStopReason !== undefined ||
    entry.projectSessionTerminalPending === true ||
    entry.projectSessionTerminalObservedAt !== undefined;
  const onAbort = () => {
    clearTimeout(queueTimer);
    notifyGatewayWorkMetricsChanged();
  };
  const bindAgentRunDelegatedAuthority = (authority: AgentRunDelegatedAuthority) => {
    const entry = params.chatAbortControllers.get(params.runId);
    if (
      entry?.controller !== controller ||
      entry.registrationCleanupRequested ||
      !entry.operationalRunInstance ||
      authority.operationalRunInstance !== entry.operationalRunInstance
    ) {
      throw new Error("agent run authority does not belong to this controller registration");
    }
    if (entry.agentRunDelegatedAuthority && entry.agentRunDelegatedAuthority !== authority) {
      throw new Error("agent run controller already owns a different authority");
    }
    entry.agentRunDelegatedAuthority = authority;
  };
  let executionStarted = false;
  const markExecutionStarted = () => {
    if (executionStarted) {
      return false;
    }
    const entry = params.chatAbortControllers.get(params.runId);
    if (entry?.controller !== controller || isStopped(entry)) {
      return false;
    }
    if (params.onQueueTimeout && !isFutureDateTimestampMs(queueDeadlineMs, { nowMs: Date.now() })) {
      params.onQueueTimeout(entry);
      return false;
    }
    executionStarted = true;
    entry.executionStarted = true;
    clearTimeout(queueTimer);
    if (entry.kind !== "agent") {
      return true;
    }
    const now = Date.now();
    if (!isFutureDateTimestampMs(entry.expiresAtMs, { nowMs: now })) {
      return true;
    }
    entry.expiresAtMs = resolveAgentRunExpiresAtMs({
      now,
      timeoutMs: params.timeoutMs,
    });
    return true;
  };
  const cleanup = () => {
    clearTimeout(queueTimer);
    const entry = params.chatAbortControllers.get(params.runId);
    if (entry?.controller === controller) {
      // This registration carries the exact operational instance. Close its
      // capability before terminal cleanup can observe a same-run successor.
      if (entry.agentRunDelegatedAuthority) {
        releaseAgentRunDelegatedAuthority(entry.agentRunDelegatedAuthority);
      }
      entry.registrationCleanupRequested = true;
      entry.projectSessionActive = false;
      entry.pendingTimeoutCompletion = undefined;
      notifyGatewayWorkMetricsChanged();
      // Terminal event handling owns final removal once the event has been
      // observed. Runs that never emitted a terminal event still clean up here.
      if (entry.projectSessionTerminalPending === true) {
        return;
      }
      const persistence = entry.projectSessionTerminalPersistence;
      if (persistence) {
        void persistence
          .then(() => {
            if (
              params.chatAbortControllers.get(params.runId)?.controller === controller &&
              entry.projectSessionTerminalPersistence === persistence
            ) {
              entry.projectSessionTerminalPersistence = undefined;
              removeChatAbortControllerEntry(params.chatAbortControllers, params.runId, entry);
            }
          })
          .catch(() => {
            if (
              params.chatAbortControllers.get(params.runId)?.controller === controller &&
              entry.projectSessionTerminalPersistence === persistence
            ) {
              removeChatAbortControllerEntry(params.chatAbortControllers, params.runId, entry);
            }
          });
        return;
      }
      removeChatAbortControllerEntry(params.chatAbortControllers, params.runId, entry);
    }
  };

  if (!params.sessionKey || params.chatAbortControllers.has(params.runId)) {
    // Duplicate run ids keep their fresh controller for caller cancellation, but
    // do not replace the registered entry that owns active-run projection.
    return {
      controller,
      registered: false,
      deferTimeoutCompletion: () => false,
      markExecutionStarted,
      bindAgentRunDelegatedAuthority,
      cleanup,
    };
  }

  const now = resolveDateTimestampMs(rawNow, 0);
  const explicitExpiresAtMs =
    params.expiresAtMs === undefined ? undefined : (asDateTimestampMs(params.expiresAtMs) ?? 0);
  const entry: ChatAbortControllerEntry = {
    controller,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    lifecycleGeneration: params.lifecycleGeneration ?? getAgentEventLifecycleGeneration(),
    operationalRunInstance: params.operationalRunInstance,
    agentId: normalizeOptionalLowercaseString(params.agentId),
    startedAtMs: now,
    executionStarted: false,
    expiresAtMs:
      explicitExpiresAtMs ??
      resolveChatRunExpiresAtMs({ now: rawNow, timeoutMs: params.timeoutMs }),
    ownerConnId: params.ownerConnId,
    ownerDeviceId: params.ownerDeviceId,
    providerId: normalizeOptionalLowercaseString(params.providerId),
    authProviderId: normalizeOptionalLowercaseString(params.authProviderId),
    controlUiVisible: params.controlUiVisible,
    isAbortable: params.isAbortable,
    resolveTerminalProducer: params.resolveTerminalProducer
      ? () => params.resolveTerminalProducer?.(entry)
      : undefined,
    onRemoved: () => {
      unregisterDeadline();
      clearTimeout(queueTimer);
      controller.signal.removeEventListener("abort", onAbort);
      notifyGatewayWorkMetricsChanged();
      params.onRemoved?.();
    },
    projectSessionActive: params.projectSessionActive ?? true,
    kind: params.kind,
    turnKind: params.turnKind,
  };
  params.chatAbortControllers.set(params.runId, entry);
  const unregisterDeadline = registerAgentRunDeadlineRenewer(
    params.runId,
    () =>
      !isStopped(entry) &&
      renewChatRunExecutionDeadline({
        entries: params.chatAbortControllers,
        runId: params.runId,
        controller,
        timeoutMs: params.timeoutMs,
      }),
  );
  if (params.onQueueTimeout) {
    // The maintenance expiry includes execution grace and cannot own a queued deadline.
    queueTimer = setTimeout(() => {
      if (
        params.chatAbortControllers.get(params.runId) === entry &&
        entry.executionStarted === false &&
        !isStopped(entry)
      ) {
        params.onQueueTimeout?.(entry);
      }
    }, params.timeoutMs);
    queueTimer.unref();
  }
  controller.signal.addEventListener("abort", onAbort, { once: true });
  notifyGatewayWorkMetricsChanged();
  return {
    controller,
    registered: true,
    entry,
    deferTimeoutCompletion: (settle) => {
      // Abort requests cleanup before notifying the still-owned producer.
      if (params.chatAbortControllers.get(params.runId) !== entry) {
        return false;
      }
      entry.pendingTimeoutCompletion = {
        expiresAtMs: Date.now() + AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
        settle,
      };
      return true;
    },
    markExecutionStarted,
    bindAgentRunDelegatedAuthority,
    cleanup,
  };
}

/** Restore the newest visible run when chat.history switches back to its session.
 * Match requested and canonical keys, with agent scoping for the shared global row.
 */
export function resolveInFlightRunSnapshot(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunState: Pick<ChatRunState, "resolveBuffer" | "runs">;
  requestedSessionKey: string;
  canonicalSessionKey: string;
  agentId?: string;
  defaultAgentId?: string;
}): InFlightRunSnapshot | undefined {
  const matchesKey = (entry: ChatAbortControllerEntry, key: string): boolean => {
    if (entry.sessionKey !== key) {
      return false;
    }
    if (key !== "global") {
      return true;
    }
    const requestedAgentId =
      normalizeOptionalLowercaseString(params.agentId) ??
      normalizeOptionalLowercaseString(params.defaultAgentId);
    if (!requestedAgentId) {
      return false;
    }
    const runAgentId =
      normalizeOptionalLowercaseString(entry.agentId) ??
      normalizeOptionalLowercaseString(params.defaultAgentId);
    return runAgentId === requestedAgentId;
  };
  // Timestamp wins over insertion order; runId breaks ties deterministically.
  let best: { runId: string; startedAtMs: number } | undefined;
  for (const [runId, entry] of params.chatAbortControllers) {
    if (
      entry.projectSessionActive === false ||
      entry.controlUiVisible === false ||
      entry.controller.signal.aborted ||
      entry.kind === "agent"
    ) {
      continue;
    }
    if (
      !matchesKey(entry, params.requestedSessionKey) &&
      !matchesKey(entry, params.canonicalSessionKey)
    ) {
      continue;
    }
    const newer = best === undefined || entry.startedAtMs > best.startedAtMs;
    const tie = best !== undefined && entry.startedAtMs === best.startedAtMs && runId > best.runId;
    if (newer || tie) {
      best = { runId, startedAtMs: entry.startedAtMs };
    }
  }
  if (best === undefined) {
    return undefined;
  }
  // A run can be active before its first text arrives. Adopt it now so the UI
  // stays streaming and can reconcile the eventual reply.
  return projectInFlightRunSnapshot({
    chatRunState: params.chatRunState,
    runId: best.runId,
    startedAtMs: best.startedAtMs,
  });
}

export type ChatAbortOps = {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunState: Pick<ChatRunState, "clearRun" | "getOrCreate" | "resolveBuffer" | "runs">;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => { sessionKey: string; agentId?: string; clientRunId: string } | undefined;
  agentRunSeq: Map<string, number>;
  getRuntimeConfig?: () => OpenClawConfig;
  broadcast: GatewayBroadcastFn;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  onRunAborted?: (runId: string) => void;
};

function resolveChatAbortDeliverySessionKeys(
  ops: ChatAbortOps,
  sessionKey: string,
  agentId: string | undefined,
): string[] {
  const scopedAgentId = normalizeOptionalLowercaseString(agentId);
  if (!scopedAgentId) {
    return [sessionKey];
  }
  const canonicalKey = resolveSessionSubscriptionKey(sessionKey, scopedAgentId);
  if (canonicalKey === sessionKey) {
    return [canonicalKey];
  }
  return resolveSessionSubscriptionKeys(
    sessionKey,
    scopedAgentId,
    resolveDefaultGlobalAgentId(ops),
  );
}

function broadcastChatAborted(
  ops: ChatAbortOps,
  params: {
    runId: string;
    sessionKey: string;
    agentId?: string;
    stopReason?: string;
    message?: Record<string, unknown>;
    errorMessage?: string;
    liveTextGroup?: AbortSignal;
  },
) {
  const { runId, sessionKey, stopReason } = params;
  const errorMessage = readToolValidationErrorSummary(params.errorMessage);
  const explicitAgentId = normalizeOptionalLowercaseString(params.agentId);
  const defaultGlobalAgentId =
    sessionKey === "global" && !explicitAgentId
      ? normalizeOptionalLowercaseString(resolveDefaultGlobalAgentId(ops))
      : undefined;
  const payloadAgentId =
    sessionKey === "global" ? (explicitAgentId ?? defaultGlobalAgentId) : explicitAgentId;
  const payload = {
    runId,
    sessionKey,
    ...(payloadAgentId ? { agentId: payloadAgentId } : {}),
    seq: (ops.agentRunSeq.get(runId) ?? 0) + 1,
    state: "aborted" as const,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    message: params.message ? { ...params.message, timestamp: Date.now() } : undefined,
  };
  const deliverySessionKeys = resolveChatAbortDeliverySessionKeys(ops, sessionKey, payloadAgentId);
  ops.broadcast("chat", payload, {
    sessionKeys: deliverySessionKeys,
    ...(params.liveTextGroup ? { liveText: { group: params.liveTextGroup } } : {}),
  });
  for (const deliverySessionKey of deliverySessionKeys) {
    ops.nodeSendToSession(deliverySessionKey, "chat", payload);
  }
}

function resolveDefaultGlobalAgentId(ops: ChatAbortOps): string | undefined {
  const cfg = ops.getRuntimeConfig?.();
  if (!cfg) {
    return undefined;
  }
  const resolved = resolveRequestedSessionAgentId(cfg, "global");
  return resolved.ok ? resolved.agentId : undefined;
}

export function isChatAbortControllerEntryAbortable(entry: ChatAbortControllerEntry): boolean {
  if (entry.controller.signal.aborted) {
    return false;
  }
  try {
    return entry.isAbortable?.(entry) !== false;
  } catch {
    return false;
  }
}

export function abortChatRunById(
  ops: ChatAbortOps,
  params: {
    runId: string;
    sessionKey: string;
    stopReason?: string;
    diagnosticReason?: ChatAbortDiagnosticReason;
    onAbortCommitted?: () => void;
  },
): { aborted: boolean } {
  const { runId, sessionKey, stopReason } = params;
  const active = ops.chatAbortControllers.get(runId);
  if (!active) {
    return { aborted: false };
  }
  if (active.sessionKey !== sessionKey) {
    return { aborted: false };
  }
  if (active.registrationCleanupRequested || !isChatAbortControllerEntryAbortable(active)) {
    return { aborted: false };
  }

  const bufferedText = ops.chatRunState.resolveBuffer(runId, { final: true }).text;
  const run = ops.chatRunState.runs.get(runId);
  const liveTextGroup = run?.liveTextGroup?.signal;
  const partialText = bufferedText && bufferedText.trim() ? bufferedText : undefined;
  const canvasBlocks =
    run?.bufferIsCurrent?.() !== false &&
    (partialText || !(run?.rawBuffer ?? run?.buffer ?? "").trim())
      ? (run?.canvasBlocks ?? [])
      : [];
  // Abort listeners can clear buffers and revoke their owner synchronously.
  const message = appendChatCanvasBlocksToMessage(
    partialText || canvasBlocks.length
      ? { role: "assistant", content: partialText ? [{ type: "text", text: partialText }] : [] }
      : undefined,
    canvasBlocks,
  );
  ops.chatRunState.getOrCreate(runId).abortMarker = createChatAbortMarker();
  if (stopReason) {
    active.abortStopReason = stopReason;
  }
  active.abortDiagnosticReason = params.diagnosticReason;
  const emitTerminal = reserveAgentTerminalEvent({
    runId,
    ...(active.lifecycleGeneration ? { lifecycleGeneration: active.lifecycleGeneration } : {}),
    sessionKey,
    sessionId: active.sessionId,
    agentId: active.agentId,
  });
  // Reserve transcript settlement while this exact producer still has authority.
  try {
    params.onAbortCommitted?.();
  } catch {
    // Transcript handoff failure cannot prevent an already accepted cancellation.
  }
  active.projectSessionActive = false;
  markChatAbortTerminalOutcome(active);
  // Reserve terminal ownership before abort listeners run; synchronous caller
  // cleanup must not erase the entry before Gateway observes the event below.
  active.projectSessionTerminalPending = true;
  active.projectSessionTerminalObservedAt = undefined;
  active.registrationCleanupRequested = true;
  // Approval cancellation and run abort share this owner so authorization
  // cannot outlive the active run whose controller is about to terminate.
  if (active.agentRunDelegatedAuthority) {
    releaseAgentRunDelegatedAuthority(active.agentRunDelegatedAuthority);
  }
  try {
    ops.onRunAborted?.(runId);
  } catch {
    // Approval persistence failure must not prevent the requested run abort.
  }
  active.controller.abort(createChatAbortSignalReason(stopReason));
  ops.chatRunState.clearRun(runId);
  const removed = ops.removeChatRun(runId, runId, sessionKey);
  if (active.controlUiVisible !== false) {
    broadcastChatAborted(ops, {
      runId,
      sessionKey,
      agentId: active.agentId,
      stopReason,
      message,
      errorMessage: active.toolErrorSummary,
      liveTextGroup,
    });
  }
  emitTerminal({
    phase: "end",
    status: "cancelled",
    aborted: true,
    stopReason,
    ...(active.toolErrorSummary ? { toolErrorSummary: active.toolErrorSummary } : {}),
    // Pre-execution admission time is not an execution start.
    startedAt: active.executionStarted === false ? undefined : active.startedAtMs,
    ...(active.executionStarted === false
      ? {
          executionStarted: false,
          providerStarted: false,
          ...(stopReason === "timeout" ? { timeoutPhase: "queue" } : {}),
        }
      : {}),
    endedAt: Date.now(),
  });
  // Gateway listeners synchronously stamp the terminal observation. Keep the
  // entry as suspension-visible ownership until its persistence write settles.
  if (
    ops.chatAbortControllers.get(runId) === active &&
    active.projectSessionTerminalObservedAt === undefined &&
    !active.projectSessionTerminalPersistence
  ) {
    active.projectSessionTerminalPending = false;
    removeChatAbortControllerEntry(ops.chatAbortControllers, runId, active);
  }
  ops.agentRunSeq.delete(runId);
  if (removed?.clientRunId) {
    ops.agentRunSeq.delete(removed.clientRunId);
  }
  return { aborted: true };
}

export function updateChatRunProvider(
  chatAbortControllers: Map<string, ChatAbortControllerEntry>,
  params: {
    runId: string;
    providerId?: string;
    authProviderId?: string;
  },
): boolean {
  const entry = chatAbortControllers.get(params.runId);
  if (!entry) {
    return false;
  }
  entry.providerId = normalizeOptionalLowercaseString(params.providerId);
  entry.authProviderId = normalizeOptionalLowercaseString(params.authProviderId);
  return true;
}

export function abortChatRunsForProvider(
  ops: ChatAbortOps,
  params: {
    cfg: OpenClawConfig;
    providerId: string;
    agentId?: string;
    stopReason?: string;
  },
): { runIds: string[] } {
  const providerId = normalizeOptionalLowercaseString(params.providerId);
  const agentId = normalizeOptionalLowercaseString(params.agentId);
  if (!providerId) {
    return { runIds: [] };
  }
  const compatibilityOwnerAgentId = agentId && tryResolveLegacyCompatibilityAgentId(params.cfg);
  const matches = [...ops.chatAbortControllers.entries()].filter(([, entry]) => {
    if (
      normalizeOptionalLowercaseString(entry.authProviderId) !== providerId &&
      normalizeOptionalLowercaseString(entry.providerId) !== providerId
    ) {
      return false;
    }
    return (
      !agentId ||
      resolveChatRunOwnerAgentId({
        agentId: entry.agentId,
        sessionKey: entry.sessionKey,
        defaultAgentId: compatibilityOwnerAgentId,
      }) === agentId
    );
  });
  const runIds: string[] = [];
  for (const [runId, entry] of matches) {
    const result = abortChatRunById(ops, {
      runId,
      sessionKey: entry.sessionKey,
      stopReason: params.stopReason,
    });
    if (result.aborted) {
      runIds.push(runId);
    }
  }
  return { runIds };
}
