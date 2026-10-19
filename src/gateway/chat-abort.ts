import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
  isAgentRunDirectAbortReason,
  resolveAgentRunAbortLifecycleFields,
} from "../agents/run-termination.js";
import { readToolValidationErrorSummary } from "../agents/tool-error-summary.js";
import type { QueueSettings } from "../auto-reply/reply/queue/types.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  reserveAgentTerminalEvent,
  getAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import {
  releaseAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import {
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  captureSessionTarget,
  type SessionTarget,
} from "../sessions/session-controller.lifecycle.js";
import {
  adoptSessionControllerSource,
  reserveSessionControllerSource,
  retargetSessionControllerSource,
  trackSessionControllerSourceWork,
  type SessionControllerInput,
  type SessionControllerSourceAdapter,
} from "../sessions/session-controller.mailbox.js";
import {
  getRpcSourceProjectSessionActive,
  getRpcSourceStartedAt,
  getRpcSourceForGateway,
  initializeRpcSourceTiming,
  markRpcSourceExecutionStarted,
  getRpcSourceIdentity,
  getRpcSourceLifecycleGeneration,
  isRpcSourceExecuting,
  isRpcSourceRegistered,
  listRpcSourceEntries,
  registerRpcSource,
  retireRpcSource,
  requestRpcSourceCancellation,
  setRpcSourceProjectSessionActive,
  type RpcSourceAdapter,
  type RpcSourceRef,
} from "../sessions/session-controller.rpc-sources.js";
import {
  captureSessionControllerStop,
  isSessionControllerInputWaitingForLocalModel,
  stopSession,
} from "../sessions/session-controller.stop.js";
import {
  resolveChatAbortDiagnosticReason,
  type ChatAbortDiagnosticReason,
} from "./chat-abort-diagnostics.js";
import {
  markChatAbortTerminalOutcome,
  notifyChatAbortControllerRemoved,
  waitForChatAbortTerminalPersistence,
} from "./chat-abort-lifecycle-internal.js";
import { appendChatCanvasBlocksToMessage } from "./chat-display-projection.canvas.js";
import { resolveChatRunOwnerAgentId } from "./chat-run-owner.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import { createChatAbortMarker, type ChatRunState } from "./server-chat-state.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { captureGatewayScopeMatcher } from "./session-runtime-scope.js";
import {
  resolveSessionSubscriptionKey,
  resolveSessionSubscriptionKeys,
} from "./session-subscription-keys.js";

export { resolveAgentRunExpiresAtMs, resolveChatRunExpiresAtMs } from "./chat-run-deadline.js";

export type RestartRecoveryCandidate = {
  storePath: string;
  agentId: string | undefined;
  runId: string;
  sourceRunId?: string;
  lifecycleGeneration: string;
  sessionKey: string;
  sessionId: string;
  observedAt?: number;
};

type RegisteredChatAbortController = {
  controller: AbortController;
  initializeTiming: (options?: {
    timeoutMs?: number;
    now?: number;
    expiresAtMs?: number;
    onQueueTimeout?: (entry: RpcSourceRef) => void;
  }) => void;
  markExecutionStarted: () => boolean;
  bindAgentRunDelegatedAuthority: (authority: AgentRunDelegatedAuthority) => void;
  cleanup: () => void;
} & (
  | { registered: true; entry: RpcSourceRef; existingEntry?: undefined }
  | { registered: false; entry?: undefined; existingEntry?: RpcSourceRef }
);

/** Map controller cancellation into the existing Gateway Stop vocabulary. */
export function resolveChatAbortStopReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (isAgentRunDirectAbortReason(reason)) {
    return reason instanceof Error &&
      "gatewayStopReason" in reason &&
      typeof reason.gatewayStopReason === "string"
      ? reason.gatewayStopReason
      : "rpc";
  }
  return typeof reason === "string"
    ? reason
    : (resolveAgentRunAbortLifecycleFields(signal).stopReason ?? "rpc");
}

export function createChatAbortSignalReason(stopReason: string | undefined): Error {
  if (stopReason === "restart") {
    return createAgentRunRestartAbortError();
  }
  if (stopReason !== "timeout") {
    // Keep transport presentation separate from the typed lifecycle cause.
    return Object.assign(createAgentRunDirectAbortError(), { gatewayStopReason: stopReason });
  }
  const reason = new Error("chat run timed out");
  reason.name = "TimeoutError";
  return reason;
}

function createUnregisteredChatAbortController(
  existingEntry: RpcSourceRef | undefined,
): RegisteredChatAbortController {
  return {
    controller: new AbortController(),
    registered: false,
    ...(existingEntry ? { existingEntry } : {}),
    initializeTiming: () => {},
    markExecutionStarted: () => false,
    bindAgentRunDelegatedAuthority: () => {
      throw new Error("Unregistered source cannot own a projected run authority");
    },
    cleanup: () => {},
  };
}

export function registerChatAbortController(params: {
  target?: SessionTarget;
  policy?: QueueSettings;
  authority?: SessionControllerSourceAdapter["authority"];
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
  resolveTerminalProducer?: (
    entry: RpcSourceRef,
  ) => ReturnType<NonNullable<RpcSourceAdapter["resolveTerminalProducer"]>>;
  onRemoved?: () => void;
  onQueueTimeout?: (entry: RpcSourceRef) => void;
  kind?: RpcSourceAdapter["kind"];
  turnKind?: RpcSourceAdapter["turnKind"];
  lifecycleGeneration?: string;
  operationalRunInstance?: OperationalRunInstanceRef;
  /** Raw source work includes preparation and source-specific terminal publication. */
  sourceWork?: Promise<unknown>;
  onCancel?: (stopReason: string) => void;
  sourceInput?: SessionControllerInput;
}): RegisteredChatAbortController {
  // Sessionless RPCs retain prepared authority without a fabricated session owner.
  if (!params.sessionKey) {
    return createUnregisteredChatAbortController(undefined);
  }
  if (!params.target) {
    throw new Error("RPC source requires its captured physical session target");
  }
  const resolveGatewayContext = params.sourceInput
    ? getGatewayContextResolver(params.sourceInput)
    : getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  const existingEntry = getRpcSourceForGateway(params.runId, resolveGatewayContext);
  if (existingEntry) {
    const ownEntry =
      getRpcSourceForGateway(params.runId, resolveGatewayContext, params.target) === existingEntry;
    if (ownEntry && params.sourceInput) {
      throw new Error("Reserved source cannot adopt an existing RPC registration");
    }
    return createUnregisteredChatAbortController(ownEntry ? existingEntry : undefined);
  }
  const adapter: RpcSourceAdapter = {
    authority: params.authority,
    requester: { connectionId: params.ownerConnId, deviceId: params.ownerDeviceId },
    lifecycleGeneration: params.lifecycleGeneration ?? getAgentEventLifecycleGeneration(),
    operationalRunInstance: params.operationalRunInstance,
    providerId: normalizeOptionalLowercaseString(params.providerId),
    authProviderId: normalizeOptionalLowercaseString(params.authProviderId),
    controlUiVisible: params.controlUiVisible ?? params.projectSessionActive,
    projectSessionActive: params.projectSessionActive,
    kind: params.kind,
    turnKind: params.turnKind,
  };
  const target =
    params.target.agentId || !params.agentId
      ? params.target
      : captureSessionTarget({ ...params.target, agentId: params.agentId });
  const policy = params.policy ?? { mode: "followup" };
  const input =
    params.sourceInput ??
    reserveSessionControllerSource(params.sessionKey, {
      protocolRunId: params.runId,
      sourceTurnId: params.runId,
      sourceSessionId: params.sessionId,
      policy,
      target,
      adapter,
    });
  if (params.sourceInput) {
    if (target !== params.target) {
      retargetSessionControllerSource(input, target);
    }
    adoptSessionControllerSource(input, {
      protocolRunId: params.runId,
      target,
      policy,
      adapter,
    });
  }
  if (params.sourceWork) {
    trackSessionControllerSourceWork(input, params.sourceWork);
  }
  const entry: RpcSourceRef = { input, adapter };
  adapter.cancellationAcknowledgment = () => waitForChatAbortTerminalPersistence(entry);
  adapter.cancel = () => {
    adapter.abortStopReason ??= resolveChatAbortStopReason(input.abortSignal);
    adapter.abortDiagnosticReason ??= resolveChatAbortDiagnosticReason(input.abortSignal, adapter);
    params.onCancel?.(adapter.abortStopReason);
  };
  adapter.resolveTerminalProducer = params.resolveTerminalProducer
    ? () => params.resolveTerminalProducer?.(entry)
    : undefined;
  // This forwarding handle owns no independent cancellation state.
  const controller: AbortController = {
    signal: input.abortSignal,
    abort: (reason?: unknown) => {
      requestRpcSourceCancellation(entry, reason ?? createAgentRunDirectAbortError());
    },
  };
  const cleanup = () => {
    if (!isRpcSourceRegistered(entry)) {
      return;
    }
    if (adapter.agentRunDelegatedAuthority) {
      releaseAgentRunDelegatedAuthority(adapter.agentRunDelegatedAuthority);
    }
    // Claimed and injected sources settle through their controller operation.
    // The settlement observer removes the protocol index without a Gateway flag.
    if (
      input.injection ||
      (input.claim && !input.claim.released) ||
      (input.custody.enqueued && input.phase !== "consumed")
    ) {
      return;
    }
    const persistence = adapter.projectSessionTerminalPersistence;
    if (persistence) {
      trackSessionControllerSourceWork(input, persistence);
    }
    retireRpcSource(params.runId, entry);
  };
  registerRpcSource(params.runId, entry, () => {
    try {
      params.onRemoved?.();
    } finally {
      notifyChatAbortControllerRemoved(entry);
    }
  });
  return {
    controller,
    registered: true,
    entry,
    initializeTiming: (options) => {
      const onQueueTimeout = options?.onQueueTimeout ?? params.onQueueTimeout;
      initializeRpcSourceTiming(entry, {
        timeoutMs: options?.timeoutMs ?? params.timeoutMs,
        now: options?.now,
        expiresAtMs: options?.expiresAtMs,
        onQueueTimeout: onQueueTimeout ? () => onQueueTimeout(entry) : undefined,
      });
    },
    markExecutionStarted: () => markRpcSourceExecutionStarted(entry),
    bindAgentRunDelegatedAuthority: (authority) => {
      if (
        !isRpcSourceRegistered(entry) ||
        !adapter.operationalRunInstance ||
        authority.operationalRunInstance !== adapter.operationalRunInstance ||
        (adapter.agentRunDelegatedAuthority && adapter.agentRunDelegatedAuthority !== authority)
      ) {
        throw new Error("Agent authority does not belong to this exact RPC source");
      }
      adapter.agentRunDelegatedAuthority = authority;
    },
    cleanup,
  };
}

export type ChatAbortOps = {
  resolveGatewayContext?: GatewayContextResolver;
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
    localModelMayStillBeFinishing?: boolean;
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
    ...(params.localModelMayStillBeFinishing ? { localModelMayStillBeFinishing: true } : {}),
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

export function captureChatRunAbortPresentation(ops: ChatAbortOps, runId: string) {
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
  return { message, liveTextGroup };
}

export function abortChatRunById(
  ops: ChatAbortOps,
  params: {
    runId: string;
    sessionKey: string;
    stopReason?: string;
    diagnosticReason?: ChatAbortDiagnosticReason;
    onAbortPrepared?: () => (() => void) | void;
    onAbortCommitted?: () => void;
    expectedEntry?: RpcSourceRef;
    /** Shutdown can cancel retained cleanup without replacing an already published terminal. */
    preserveTerminal?: boolean;
    presentation?: ReturnType<typeof captureChatRunAbortPresentation>;
    /** Exact primitive supplied by the common captured Stop sequencer. */
    cancel?: () => boolean;
    assertCurrent?: () => void;
  },
): { aborted: boolean } {
  const { runId, sessionKey, stopReason } = params;
  params.assertCurrent?.();
  const active = params.expectedEntry ?? getRpcSourceForGateway(runId, ops.resolveGatewayContext);
  if (!active || active.input.protocolRunId !== runId || !isRpcSourceRegistered(active)) {
    return { aborted: false };
  }
  const identity = getRpcSourceIdentity(active);
  if (identity.sessionKey !== sessionKey) {
    return { aborted: false };
  }
  const executionStarted = isRpcSourceExecuting(active);
  const terminal = params.preserveTerminal
    ? undefined
    : reserveAgentTerminalEvent({
        runId,
        lifecycleGeneration: getRpcSourceLifecycleGeneration(active),
        sessionKey,
        sessionId: identity.sessionId,
        agentId: identity.agentId,
      });
  const priorRetirement = active.input.retirementRequested;
  const priorOperationResult = active.input.claim?.operation?.result;
  const { message, liveTextGroup } =
    params.presentation ?? captureChatRunAbortPresentation(ops, runId);
  const runProjection = ops.chatRunState.getOrCreate(runId);
  const previousMarker = runProjection.abortMarker;
  const previousProjectSessionActive = getRpcSourceProjectSessionActive(active);
  const previous = {
    abortStopReason: active.adapter.abortStopReason,
    abortDiagnosticReason: active.adapter.abortDiagnosticReason,
    projectSessionTerminalPending: active.adapter.projectSessionTerminalPending,
    projectSessionTerminalObservedAt: active.adapter.projectSessionTerminalObservedAt,
  };
  runProjection.abortMarker = createChatAbortMarker();
  if (stopReason) {
    active.adapter.abortStopReason = stopReason;
  }
  active.adapter.abortDiagnosticReason = params.diagnosticReason;
  // Reserve transcript settlement while this exact producer still has authority.
  let revokeAbortPreparation: (() => void) | undefined;
  try {
    const preparation = params.onAbortPrepared?.();
    if (typeof preparation === "function") {
      revokeAbortPreparation = preparation;
    }
  } catch {
    // Transcript handoff failure cannot prevent an already accepted cancellation.
  }
  setRpcSourceProjectSessionActive(active, false);
  // Reserve terminal ownership before abort listeners run; synchronous caller
  // cleanup must not erase the entry before Gateway observes the event below.
  if (!params.preserveTerminal) {
    active.adapter.projectSessionTerminalPending = true;
    active.adapter.projectSessionTerminalObservedAt = undefined;
  }
  const restorePrevious = () => {
    terminal?.release();
    revokeAbortPreparation?.();
    Object.assign(active.adapter, previous);
    setRpcSourceProjectSessionActive(active, previousProjectSessionActive);
    runProjection.abortMarker = previousMarker;
  };
  const localModelMayStillBeFinishing = isSessionControllerInputWaitingForLocalModel(active.input);
  let cancelled: boolean;
  let cancellationFailure: { error: unknown } | undefined;
  try {
    cancelled = params.cancel
      ? params.cancel()
      : requestRpcSourceCancellation(
          active,
          createChatAbortSignalReason(stopReason),
          params.assertCurrent,
        );
  } catch (error) {
    cancelled =
      (!priorOperationResult && active.input.claim?.operation?.result?.kind === "aborted") ||
      (!priorRetirement &&
        active.input.retirementRequested === true &&
        active.input.abortSignal.aborted);
    if (!cancelled) {
      restorePrevious();
      throw error;
    }
    cancellationFailure = { error };
  }
  if (!cancelled) {
    restorePrevious();
    return { aborted: false };
  }
  // Cancellation is committed. These publication/revocation receipts finish even if
  // a synchronous abort listener revoked the requesting connection.
  if (active.adapter.agentRunDelegatedAuthority) {
    releaseAgentRunDelegatedAuthority(active.adapter.agentRunDelegatedAuthority);
  }
  markChatAbortTerminalOutcome(active);
  params.onAbortCommitted?.();
  const replacement = getRpcSourceForGateway(runId, getGatewayContextResolver(active.input));
  if (replacement && replacement !== active) {
    terminal?.release();
    if (!params.preserveTerminal) {
      active.adapter.projectSessionTerminalPending = false;
    }
    if (cancellationFailure) {
      throw cancellationFailure.error;
    }
    return { aborted: true };
  }
  try {
    ops.onRunAborted?.(runId);
  } catch {
    /* Requested cancellation already committed. */
  }
  if (ops.chatRunState.runs.get(runId) === runProjection) {
    ops.chatRunState.clearRun(runId);
  }
  const removed = ops.removeChatRun(runId, runId, sessionKey);
  if (!params.preserveTerminal && active.adapter.controlUiVisible !== false) {
    broadcastChatAborted(ops, {
      runId,
      sessionKey,
      agentId: identity.agentId,
      stopReason,
      message,
      errorMessage: active.adapter.toolErrorSummary,
      localModelMayStillBeFinishing,
      liveTextGroup,
    });
  }
  if (!params.preserveTerminal) {
    terminal?.publish({
      phase: "end",
      status: "cancelled",
      aborted: true,
      stopReason,
      ...(active.adapter.toolErrorSummary
        ? { toolErrorSummary: active.adapter.toolErrorSummary }
        : {}),
      // Pre-execution admission time is not an execution start.
      startedAt: !executionStarted ? undefined : (getRpcSourceStartedAt(active) ?? 0),
      ...(!executionStarted
        ? {
            executionStarted: false,
            providerStarted: false,
            ...(stopReason === "timeout" ? { timeoutPhase: "queue" } : {}),
          }
        : {}),
      endedAt: Date.now(),
    });
  }
  // Gateway listeners synchronously stamp the terminal observation. Keep the
  // entry as suspension-visible ownership until its persistence write settles.
  if (
    !params.preserveTerminal &&
    isRpcSourceRegistered(active) &&
    active.adapter.projectSessionTerminalObservedAt === undefined &&
    !active.adapter.projectSessionTerminalPersistence
  ) {
    active.adapter.projectSessionTerminalPending = false;
    retireRpcSource(runId, active);
  } else if (params.preserveTerminal) {
    retireRpcSource(runId, active);
  }
  ops.agentRunSeq.delete(runId);
  if (removed?.clientRunId) {
    ops.agentRunSeq.delete(removed.clientRunId);
  }
  if (cancellationFailure) {
    throw cancellationFailure.error;
  }
  return { aborted: true };
}

export function updateChatRunProvider(params: {
  runId: string;
  resolveGatewayContext?: GatewayContextResolver;
  providerId?: string;
  authProviderId?: string;
}): boolean {
  const entry = getRpcSourceForGateway(params.runId, params.resolveGatewayContext);
  if (!entry) {
    return false;
  }
  entry.adapter.providerId = normalizeOptionalLowercaseString(params.providerId);
  entry.adapter.authProviderId = normalizeOptionalLowercaseString(params.authProviderId);
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
  const matchesGateway = captureGatewayScopeMatcher(ops.resolveGatewayContext);
  const matches = listRpcSourceEntries().filter(([, entry]) => {
    if (!matchesGateway(entry.input)) {
      return false;
    }
    const identity = getRpcSourceIdentity(entry);
    if (
      normalizeOptionalLowercaseString(entry.adapter.authProviderId) !== providerId &&
      normalizeOptionalLowercaseString(entry.adapter.providerId) !== providerId
    ) {
      return false;
    }
    return (
      !agentId ||
      resolveChatRunOwnerAgentId({
        agentId: identity.agentId,
        sessionKey: identity.sessionKey,
        defaultAgentId: compatibilityOwnerAgentId,
      }) === agentId
    );
  });
  const runIds: string[] = [];
  const byInput = new Map(
    matches.map(([runId, entry]) => [
      entry.input,
      { runId, entry, presentation: captureChatRunAbortPresentation(ops, runId) },
    ]),
  );
  const capture = captureSessionControllerStop({ inputs: byInput.keys() });
  stopSession({
    capture,
    source: "operator-revocation",
    reason: createChatAbortSignalReason(params.stopReason),
    cancelInput: (input, cancel) => {
      const target = byInput.get(input);
      if (!target) {
        return false;
      }
      return abortChatRunById(ops, {
        runId: target.runId,
        sessionKey: getRpcSourceIdentity(target.entry).sessionKey,
        expectedEntry: target.entry,
        presentation: target.presentation,
        cancel,
        stopReason: params.stopReason,
        onAbortCommitted: () => runIds.push(target.runId),
      }).aborted;
    },
  });
  return { runIds };
}
