import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import {
  resolveAgentRunExpiresAtMs,
  resolveChatRunExpiresAtMs,
} from "../gateway/chat-run-deadline.js";
import { chatRunBelongsToAgent } from "../gateway/chat-run-owner.js";
import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import { captureGatewayScopeMatcher } from "../gateway/session-runtime-scope.js";
import { registerAgentRunDeadlineRenewer } from "../infra/agent-run-deadline.js";
import { notifyGatewayWorkMetricsChanged } from "../infra/gateway-work-metrics-events.js";
import { getGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { getSessionControllerSourceIdentity } from "./session-controller.identity.js";
import {
  isSessionControllerSourceQueued,
  retireSessionControllerInput,
  type SessionControllerInput,
} from "./session-controller.mailbox.js";
import type { RpcSourceRef, RpcSourceTiming } from "./session-controller.rpc-sources.types.js";
import {
  findSessionControllerEntries,
  getSessionControllerEntryForOperation,
  hasReplyOperationExecutionStarted,
  isCurrentSessionControllerOperation,
  sessionControllers,
} from "./session-controller.state.js";
import {
  cancelCapturedSessionControllerSource,
  captureSessionControllerStop,
} from "./session-controller.stop.js";
import { rpcSourceRemovalByRef, rpcSourcesByRunId } from "./session-controller.storage.js";
import type { SessionTarget } from "./session-controller.target.js";
export type { RpcSourceAdapter, RpcSourceRef } from "./session-controller.rpc-sources.types.js";

export type RpcSourceIdentity = ReturnType<typeof getSessionControllerSourceIdentity>;

/** Reads logical identity from the exact operation, then its captured source target. */
export function getRpcSourceIdentity(ref: RpcSourceRef): RpcSourceIdentity {
  return getSessionControllerSourceIdentity(ref.input);
}

/** Reads lifecycle generation from the operation once a turn owns the source. */
export function getRpcSourceLifecycleGeneration(ref: RpcSourceRef): string | undefined {
  return ref.input.claim?.operation?.lifecycleGeneration ?? ref.adapter.lifecycleGeneration;
}

/** Updates the controller-owned source identity and its operation, when claimed. */
export function updateRpcSourceSessionId(ref: RpcSourceRef, sessionId: string): void {
  const normalized = sessionId.trim();
  if (!normalized) {
    return;
  }
  ref.input.sourceSessionId = normalized;
  ref.input.claim?.operation?.updateSessionId(normalized);
}

function removeRpcSource(runId: string, ref: RpcSourceRef): boolean {
  const sources = rpcSourcesByRunId.get(runId);
  if (!sources?.delete(ref)) {
    return false;
  }
  if (sources.size === 0) {
    rpcSourcesByRunId.delete(runId);
  }
  notifyGatewayWorkMetricsChanged();
  const onRemoved = rpcSourceRemovalByRef.get(ref);
  rpcSourceRemovalByRef.delete(ref);
  try {
    onRemoved?.();
  } catch {
    // Removal observers cannot reject controller settlement.
  }
  return true;
}

/** Resolves the exact controller-owned source registered for a protocol run. */
export function getRpcSource(runId: string): RpcSourceRef | undefined {
  const sources = rpcSourcesByRunId.get(runId);
  return sources?.size === 1 ? sources.values().next().value : undefined;
}

/** Signal-owned control selects its exact input even when another Gateway reuses the ID. */
export function getRpcSourceForSignal(
  runId: string,
  signal: AbortSignal,
): RpcSourceRef | undefined {
  return [...(rpcSourcesByRunId.get(runId) ?? [])].find(
    (source) => source.input.abortSignal === signal,
  );
}

/** Selects the captured Gateway, including explicit unbound ownership, across callbacks. */
export function getRpcSourceForGateway(
  runId: string,
  resolveGatewayContext: GatewayContextResolver | undefined,
  target?: SessionTarget,
): RpcSourceRef | undefined {
  const matchesGateway = captureGatewayScopeMatcher(resolveGatewayContext);
  const owners = target && new Set(findSessionControllerEntries(target.sessionKey, target));
  const sources = [...(rpcSourcesByRunId.get(runId) ?? [])].filter(
    (source) => matchesGateway(source.input) && (!owners || owners.has(source.input.mailbox.owner)),
  );
  return sources.length === 1 ? sources[0] : undefined;
}

/** Reports whether this exact source remains in the controller-owned index. */
export function isRpcSourceRegistered(ref: RpcSourceRef): boolean {
  const runId = ref.input.protocolRunId;
  return runId !== undefined && rpcSourcesByRunId.get(runId)?.has(ref) === true;
}

/** Reports whether this protocol ID is still owned by the source's controller target. */
export function hasRpcSourceForController(runId: string, ref: RpcSourceRef): boolean {
  const matchesGateway = captureGatewayScopeMatcher(getGatewayContextResolver(ref.input));
  return [...(rpcSourcesByRunId.get(runId) ?? [])].some(
    (source) =>
      source.input.mailbox.owner === ref.input.mailbox.owner && matchesGateway(source.input),
  );
}

/** Resolves one pre-registration source; an omitted Gateway inspects the global index. */
export function getReservedRpcSourceInput(
  runId: string,
  gateway?: { resolveGatewayContext: GatewayContextResolver | undefined },
): SessionControllerInput | undefined {
  if (
    gateway ? getRpcSourceForGateway(runId, gateway.resolveGatewayContext) : hasRpcSource(runId)
  ) {
    return undefined;
  }
  const matchesGateway = gateway && captureGatewayScopeMatcher(gateway.resolveGatewayContext);
  let match: SessionControllerInput | undefined;
  for (const entry of sessionControllers.values()) {
    for (const input of entry.mailbox?.entries ?? []) {
      if (
        input.protocolRunId !== runId ||
        (matchesGateway && !matchesGateway(input)) ||
        input.phase === "consumed" ||
        input.retirementRequested ||
        input.custody.cancellationRetired
      ) {
        continue;
      }
      if (match && match !== input) {
        return undefined;
      }
      match = input;
    }
  }
  return match;
}

/** Reports whether the controller owns a source for a protocol run. */
export function hasRpcSource(runId: string): boolean {
  return (rpcSourcesByRunId.get(runId)?.size ?? 0) > 0;
}

/** Reports whether an indexed source can still own the matching protocol attempt. */
export function hasUnretiredRpcSource(
  runId: string,
  scope: Partial<RpcSourceIdentity>,
  resolveGatewayContext: GatewayContextResolver | undefined,
): boolean {
  const ref = getRpcSourceForGateway(runId, resolveGatewayContext);
  if (!ref) {
    return false;
  }
  const identity = getRpcSourceIdentity(ref);
  return (
    ref.input.phase !== "consumed" &&
    !ref.input.retirementRequested &&
    !ref.input.custody.cancellationRetired &&
    !ref.input.abortSignal.aborted &&
    (scope.sessionId === undefined || identity.sessionId === scope.sessionId) &&
    (scope.sessionKey === undefined || identity.sessionKey === scope.sessionKey) &&
    (scope.agentId === undefined || identity.agentId === scope.agentId)
  );
}

/** Returns a stable snapshot for Gateway projection, shutdown, and abort iteration. */
export function listRpcSourceEntries(): Array<[runId: string, ref: RpcSourceRef]> {
  const entries: Array<[string, RpcSourceRef]> = [];
  for (const [runId, sources] of rpcSourcesByRunId) {
    for (const ref of sources) {
      entries.push([runId, ref]);
    }
  }
  return entries;
}

/** Returns sources owned by the exact physical controller selected by a captured target. */
export function listRpcSourceEntriesForTarget(
  target: SessionTarget,
): Array<[runId: string, ref: RpcSourceRef]> {
  const owners = new Set(findSessionControllerEntries(target.sessionKey, target));
  return listRpcSourceEntries().filter(([, source]) => owners.has(source.input.mailbox.owner));
}

/** Registers protocol correlation after the controller has reserved the source input. */
export function registerRpcSource(runId: string, ref: RpcSourceRef, onRemoved?: () => void): void {
  if (ref.input.protocolRunId !== runId) {
    throw new Error("RPC source protocol ID does not match its index key");
  }
  const sources = rpcSourcesByRunId.get(runId) ?? new Set<RpcSourceRef>();
  const matchesGateway = captureGatewayScopeMatcher(getGatewayContextResolver(ref.input));
  // Public waits remain runId-only inside one Gateway, across all physical targets.
  if ([...sources].some((source) => matchesGateway(source.input))) {
    throw new Error(`RPC source already registered for run ${runId}`);
  }
  sources.add(ref);
  rpcSourcesByRunId.set(runId, sources);
  ref.input.custody.rpcAccepted = true;
  notifyGatewayWorkMetricsChanged();
  if (onRemoved) {
    rpcSourceRemovalByRef.set(ref, onRemoved);
  }
  const settled = () => removeRpcSource(runId, ref);
  void ref.input.settlement.promise.then(settled, settled);
}

/** Requests retirement; the index leaves only when the exact controller input settles. */
export function retireRpcSource(runId: string, expected?: RpcSourceRef): boolean {
  const ref = expected ?? getRpcSource(runId);
  if (
    !ref ||
    ref.input.protocolRunId !== runId ||
    rpcSourcesByRunId.get(runId)?.has(ref) !== true
  ) {
    return false;
  }
  if (
    ref.adapter.projectSessionTerminalPending === true &&
    !ref.adapter.projectSessionTerminalPersistence
  ) {
    ref.input.retirementRequested = true;
    return true;
  }
  retireSessionControllerInput(ref.input);
  // Synchronous settlement removes the input from its mailbox. A consumed
  // input still in the mailbox owns asynchronous cleanup and keeps its RPC ID.
  if (ref.input.phase === "consumed" && !ref.input.mailbox.entries.includes(ref.input)) {
    removeRpcSource(runId, ref);
  }
  return true;
}

export function isRpcSourceQueued(ref: RpcSourceRef | undefined): boolean {
  return (
    ref !== undefined &&
    isSessionControllerSourceQueued(ref.input) &&
    !ref.input.custody.cancellationRetired &&
    !ref.input.abortSignal.aborted
  );
}

/** Waiting input may be discarded by a committed history cut; producers must settle first. */
export function isRpcSourceWaitingForTurn(ref: RpcSourceRef): boolean {
  return (
    isRpcSourceQueued(ref) &&
    !ref.input.claim &&
    ref.input.phase !== "injecting" &&
    !ref.input.retirementRequested &&
    !ref.adapter.terminalOutcomeObserved &&
    ref.adapter.projectSessionTerminalObservedAt === undefined &&
    ref.adapter.projectSessionTerminalPending !== true &&
    ref.adapter.projectSessionTerminalPersistence === undefined &&
    ref.adapter.projectSessionTerminalPersisted !== true
  );
}

/** Projection only: reservations, preparing input and retained receipts are not execution. */
export function isRpcSourceExecuting(ref: RpcSourceRef | undefined): boolean {
  const claim = ref?.input.claim;
  const operation = claim?.operation;
  return (
    ref !== undefined &&
    operation !== undefined &&
    !claim?.released &&
    !operation.result &&
    isCurrentSessionControllerOperation(operation) &&
    hasReplyOperationExecutionStarted(operation) &&
    !operation.abortSignal.aborted &&
    !ref.input.abortSignal.aborted
  );
}

export function isRpcSourceActive(ref: RpcSourceRef | undefined): boolean {
  return isRpcSourceExecuting(ref) && getRpcSourceProjectSessionActive(ref) !== false;
}

/** Registered preparation and queued input stay visible until their exact source settles. */
export function resolveRpcSourceSessionProgressState(
  ref: RpcSourceRef | undefined,
): "queued" | "running" | undefined {
  if (
    !ref ||
    ref.input.phase === "consumed" ||
    ref.input.retirementRequested ||
    ref.input.custody.cancellationRetired ||
    ref.input.abortSignal.aborted ||
    getRpcSourceProjectSessionActive(ref) === false
  ) {
    return undefined;
  }
  const claim = ref.input.claim;
  const operation = claim?.operation;
  if (
    (claim === undefined && ref.input.custody.rpcAccepted !== true) ||
    claim?.released ||
    operation?.result ||
    (operation !== undefined &&
      (!isCurrentSessionControllerOperation(operation) || operation.abortSignal.aborted))
  ) {
    return undefined;
  }
  return isRpcSourceExecuting(ref) ? "running" : "queued";
}

/** Reads the active-session presentation fact from the exact controller attachment. */
export function getRpcSourceProjectSessionActive(
  ref: RpcSourceRef | undefined,
): boolean | undefined {
  if (
    ref?.adapter.projectSessionTerminalPending === true ||
    ref?.adapter.projectSessionTerminalPersisted === true
  ) {
    return false;
  }
  const operation = ref?.input.claim?.operation;
  const attachment = operation && getSessionControllerEntryForOperation(operation).attachment;
  if (attachment && attachment.operation === operation) {
    return attachment.projectSessionActive;
  }
  return ref?.input.retirementRequested === true ? false : undefined;
}

/** Updates presentation on the exact operation attachment without creating a second owner. */
export function setRpcSourceProjectSessionActive(
  ref: RpcSourceRef,
  active: boolean | undefined,
): void {
  const operation = ref.input.claim?.operation;
  if (!operation) {
    return;
  }
  const entry = getSessionControllerEntryForOperation(operation);
  if (entry.active !== operation) {
    return;
  }
  if (entry.attachment?.operation === operation) {
    entry.attachment.projectSessionActive = active;
    notifyGatewayWorkMetricsChanged();
    return;
  }
  entry.attachment = { operation, projectSessionActive: active };
  notifyGatewayWorkMetricsChanged();
}

export function getRpcSourceStartedAt(ref: RpcSourceRef): number | undefined {
  if (ref.adapter.timing) {
    return ref.adapter.timing.startedAtMs;
  }
  const operation = ref.input.claim?.operation;
  return operation && hasReplyOperationExecutionStarted(operation)
    ? operation.startedAtMs
    : undefined;
}

/** @internal Exposed for unit tests only. */
export function getRpcSourceExpiresAt(ref: RpcSourceRef): number | undefined {
  return ref.adapter.timing?.expiresAtMs;
}

function canStartRpcSource(ref: RpcSourceRef): boolean {
  return (
    isRpcSourceRegistered(ref) &&
    ref.input.phase !== "consumed" &&
    !ref.input.retirementRequested &&
    !ref.input.custody.cancellationRetired &&
    !ref.input.abortSignal.aborted &&
    !ref.adapter.abortStopReason &&
    !ref.adapter.terminalOutcomeObserved &&
    !ref.adapter.projectSessionTerminalPending &&
    !ref.adapter.projectSessionTerminalPersisted &&
    ref.adapter.projectSessionTerminalObservedAt === undefined
  );
}

/** Keeps queue expiry and retry observations on the exact source, without a running timer. */
export function initializeRpcSourceTiming(
  ref: RpcSourceRef,
  params: {
    timeoutMs: number;
    now?: number;
    expiresAtMs?: number;
    onQueueTimeout?: () => void;
  },
): void {
  if (ref.adapter.timing) {
    throw new Error("RPC source timing is already initialized");
  }
  const runId = ref.input.protocolRunId;
  if (runId === undefined || !isRpcSourceRegistered(ref)) {
    throw new Error("RPC source timing requires a registered source");
  }
  const now = params.now ?? Date.now();
  let queueTimer: ReturnType<typeof setTimeout> | undefined;
  let queueExpired = false;
  const cancelQueueDeadline = () => {
    clearTimeout(queueTimer);
    queueTimer = undefined;
  };
  const timing: RpcSourceTiming = {
    queuedAtMs: resolveDateTimestampMs(now, 0),
    expiresAtMs:
      params.expiresAtMs === undefined
        ? (ref.adapter.kind === "agent" ? resolveAgentRunExpiresAtMs : resolveChatRunExpiresAtMs)({
            now,
            timeoutMs: params.timeoutMs,
          })
        : (asDateTimestampMs(params.expiresAtMs) ?? 0),
    queueDeadlineAtMs: params.onQueueTimeout
      ? (resolveExpiresAtMsFromDurationMs(params.timeoutMs, { nowMs: now }) ?? 0)
      : undefined,
    timeoutMs: params.timeoutMs,
    cancelQueueDeadline,
    expireQueue() {
      if (!queueExpired && timing.startedAtMs === undefined && canStartRpcSource(ref)) {
        queueExpired = true;
        cancelQueueDeadline();
        params.onQueueTimeout?.();
      }
    },
  };
  ref.adapter.timing = timing;
  if (!canStartRpcSource(ref)) {
    return;
  }
  const unregisterDeadline = registerAgentRunDeadlineRenewer(runId, () => {
    if (!canStartRpcSource(ref) || timing.startedAtMs === undefined) {
      return false;
    }
    const renewedAt = Date.now();
    if (!isFutureDateTimestampMs(timing.expiresAtMs, { nowMs: renewedAt })) {
      return false;
    }
    const expiresAtMs = resolveAgentRunExpiresAtMs({ now: renewedAt, timeoutMs: timing.timeoutMs });
    if (expiresAtMs <= timing.expiresAtMs) {
      return false;
    }
    timing.expiresAtMs = expiresAtMs;
    return true;
  });
  const dispose = () => {
    cancelQueueDeadline();
    unregisterDeadline();
    ref.input.abortSignal.removeEventListener("abort", dispose);
  };
  ref.input.abortSignal.addEventListener("abort", dispose, { once: true });
  void ref.input.settlement.promise.then(dispose, dispose);
  if (params.onQueueTimeout && canStartRpcSource(ref)) {
    queueTimer = setTimeout(
      timing.expireQueue,
      Math.max(0, (timing.queueDeadlineAtMs ?? 0) - Date.now()),
    );
    queueTimer.unref();
  }
}

/** Rearms a live agent's full budget once, at the first actual execution boundary. */
export function markRpcSourceExecutionStarted(ref: RpcSourceRef): boolean {
  const timing = ref.adapter.timing;
  if (!timing || timing.startedAtMs !== undefined || !canStartRpcSource(ref)) {
    return false;
  }
  const now = Date.now();
  if (
    timing.queueDeadlineAtMs !== undefined &&
    !isFutureDateTimestampMs(timing.queueDeadlineAtMs, { nowMs: now })
  ) {
    timing.expireQueue();
    return false;
  }
  timing.startedAtMs = now;
  timing.cancelQueueDeadline();
  if (ref.adapter.kind === "agent" && isFutureDateTimestampMs(timing.expiresAtMs, { nowMs: now })) {
    timing.expiresAtMs = resolveAgentRunExpiresAtMs({ now, timeoutMs: timing.timeoutMs });
  }
  notifyGatewayWorkMetricsChanged();
  return true;
}

/** Exact owner operation, not a run-ID lookup; controller owns cancellation and settlement. */
export function requestRpcSourceCancellation(
  ref: RpcSourceRef,
  reason?: unknown,
  assertCurrent: () => void = () => {},
): boolean {
  const capture = captureSessionControllerStop({ inputs: [ref.input] });
  return cancelCapturedSessionControllerSource(capture, {
    reason,
    assertCurrent,
  }).abortedInputs.includes(ref.input);
}

/** Capture presentation correlation with exact inputs; no scheduler state is copied. */
export function listRpcSourceEntriesForSession(params: {
  sessionKeys: Iterable<string>;
  sessionIds?: Iterable<string | undefined>;
  requiredSessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
  queuedOnly?: boolean;
  storeScope?: string;
  resolveGatewayContext?: GatewayContextResolver;
}): Array<{ runId: string; entry: RpcSourceRef }> {
  const keys = new Set(params.sessionKeys);
  const ids = new Set(params.sessionIds ?? []);
  const matchesGateway = Object.hasOwn(params, "resolveGatewayContext")
    ? captureGatewayScopeMatcher(params.resolveGatewayContext)
    : () => true;
  return listRpcSourceEntries().flatMap(([runId, entry]) => {
    const identity = getRpcSourceIdentity(entry);
    const matches =
      (params.storeScope === undefined || entry.input.target?.storeScope === params.storeScope) &&
      matchesGateway(entry.input) &&
      (!params.queuedOnly || isRpcSourceQueued(entry)) &&
      (keys.has(identity.sessionKey) || ids.has(identity.sessionId)) &&
      (params.requiredSessionId === undefined ||
        (keys.has(identity.sessionKey) && identity.sessionId === params.requiredSessionId)) &&
      (!params.agentId ||
        chatRunBelongsToAgent(
          {
            agentId: identity.agentId,
            sessionKey: identity.sessionKey,
            defaultAgentId: params.defaultAgentId,
          },
          params.agentId,
        ));
    return matches ? [{ runId, entry }] : [];
  });
}
