// Stores and broadcasts agent lifecycle and streaming events.
import { isDefinitiveRunLifecycle } from "@openclaw/normalization-core/agent-run-terminal-outcome";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import {
  getAgentEventExecutionContext,
  recordAgentEventRouting,
} from "./agent-event-execution-context.js";
import { hasInvalidLifecycleStartTimestamp } from "./agent-event-lifecycle.js";
import type {
  AgentAssistantProjection,
  AgentAssistantSourceReceipt,
  AgentEventPayload,
  AgentEventRuntimePayload,
} from "./agent-events.types.js";
import { createAgentRunStaleLifecycleError } from "./agent-lifecycle-error.js";
import {
  getAgentRunContext,
  getAgentRunContextOwnership,
  getAgentRunLifecycleGeneration,
  recordAgentRunModel,
  registerAgentRunSequenceResetHandler,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
} from "./agent-run-registry.js";
import type { AgentRunContext, AgentRunEventState } from "./agent-run-registry.types.js";
import { recordAgentRunOutputTokens } from "./agent-run-usage.js";

export type {
  AgentApprovalEventData,
  AgentAssistantProjection,
  AgentAssistantSourceReceipt,
  AgentEventPayload,
  AgentEventRuntimePayload,
  AgentEventStream,
} from "./agent-events.types.js";

type AgentEventListener = (
  evt: AgentEventRuntimePayload,
  isDeliveryCurrent?: () => boolean,
) => void;
type CaptureAgentEventDelivery = (evt: AgentEventRuntimePayload) => () => boolean;
type AgentEventRegistration = {
  readonly listener: AgentEventListener;
  readonly id: number;
  readonly captureDelivery?: CaptureAgentEventDelivery;
};
type AgentEventListeners = Map<AgentEventListener, AgentEventRegistration>;

type AgentEventState = {
  runs: Map<string, AgentRunEventState>;
  assistantSources?: WeakMap<object, AgentAssistantSourceReceipt>;
  listeners: AgentEventListeners;
  runListeners: Map<string, AgentEventListeners>;
  nextListenerId: number;
  listenerRevision: number;
  auditListeners: Set<(evt: AgentEventPayload) => void>;
  lifecycleRotationHandlers?: Map<string, (lifecycleGeneration: string) => void>;
};

const AGENT_EVENT_ROUTING_FIELDS = [
  ["controlUiVisible", "isControlUiVisible"],
  ["projectSessionLifecycle", "projectSessionLifecycle"],
  ["projectSessionMessages", "projectSessionMessages"],
  ["mainSessionRestartRecovery", "mainSessionRestartRecovery"],
  ["verboseLevel", "verboseLevel"],
  ["registeredAt", "registeredAt"],
] as const;

function getAgentEventState(): AgentEventState {
  // Lifecycle owners can register before an importing runtime chunk finishes initialization.
  return resolveGlobalSingleton<AgentEventState>(Symbol.for("openclaw.agentEvents.state"), () => ({
    runs: new Map(),
    listeners: new Map(),
    runListeners: new Map(),
    nextListenerId: 0,
    listenerRevision: 0,
    auditListeners: new Set<(evt: AgentEventPayload) => void>(),
  }));
}

/** Correlate copied model frames with their occurrence without changing transcript bytes. */
export function bindAgentAssistantSource(
  message: object,
  source: AgentAssistantSourceReceipt,
): void {
  (getAgentEventState().assistantSources ??= new WeakMap()).set(message, source);
}

export function readAgentAssistantSource(
  message: unknown,
): AgentAssistantSourceReceipt | undefined {
  return message && typeof message === "object"
    ? getAgentEventState().assistantSources?.get(message)
    : undefined;
}

registerAgentRunSequenceResetHandler((runId) => {
  getAgentEventState().runs.delete(runId);
});

/** Runs one execution with immutable ownership inherited by every emitted stream event. */
export function withAgentRunLifecycleGeneration<T>(lifecycleGeneration: string, run: () => T): T {
  const storage = getAgentEventExecutionContext();
  const parent = storage.getStore();
  const onceByRun =
    parent?.lifecycleGeneration === lifecycleGeneration ? parent.onceByRun : new Map();
  // Same-registration records share compaction updates, while a nested reused
  // run id replaces only its own binding. Neither scope retains live authority.
  const routingByRun = new Map(parent?.routingByRun);
  return storage.run({ lifecycleGeneration, onceByRun, routingByRun }, run);
}

type AgentTerminalEventData = Record<string, unknown> & { phase: "end" | "error" };

/** Reserves client terminal publication without advancing execution settlement. */
export function reserveAgentTerminalEvent(
  identity: Omit<AgentEventPayload, "seq" | "ts" | "stream" | "data">,
): (data: AgentTerminalEventData) => void {
  const { runId } = identity;
  const context = getAgentRunContext(runId);
  return withAgentRunLifecycleGeneration(captureAgentRunLifecycleGeneration(runId), () => {
    if (context) {
      recordAgentEventRouting(runId, context);
    }
    const resolved = resolveAgentEventRouting(identity);
    if (!resolved) {
      return () => {};
    }
    const state = getAgentEventState();
    const runState = resolved.routing?.eventState ?? state.runs.get(runId) ?? { seq: 0 };
    const publication = Symbol("agent terminal publication");
    runState.terminalPublication ??= publication;
    if (!state.runs.has(runId)) {
      state.runs.set(runId, runState);
    }
    const storage = getAgentEventExecutionContext();
    const scope = storage.getStore()!;
    let pending = true;
    return (data: AgentTerminalEventData) => {
      if (pending) {
        pending = false;
        storage.run(scope, () =>
          dispatchAgentEvent(
            { ...identity, stream: "lifecycle", data },
            undefined,
            undefined,
            publication,
          ),
        );
      }
    };
  });
}

/** Shares one operation across fallback attempts that belong to the same admitted run. */
export function runOncePerAgentRun<T>(runId: string, operation: string, run: () => Promise<T>) {
  const context = getAgentEventExecutionContext().getStore();
  if (!context) {
    return run();
  }
  const key = `${operation}:${runId}`;
  const existing = context.onceByRun.get(key);
  if (existing) {
    return existing as Promise<T>;
  }
  const pending = Promise.resolve().then(run);
  context.onceByRun.set(key, pending);
  return pending;
}

export function getAgentEventLifecycleGeneration(): string {
  return getAgentRunLifecycleGeneration();
}

export function isAgentEventLifecycleGenerationCurrent(lifecycleGeneration: string): boolean {
  return lifecycleGeneration === getAgentRunLifecycleGeneration();
}

/** Registers process-local state cleanup at the gateway lifecycle boundary. */
export function registerAgentEventLifecycleRotationHandler(
  key: string,
  handler: (lifecycleGeneration: string) => void,
): () => void {
  const state = getAgentEventState();
  const handlers =
    state.lifecycleRotationHandlers ??
    (state.lifecycleRotationHandlers = new Map<string, (lifecycleGeneration: string) => void>());
  handlers.set(key, handler);
  return () => {
    if (handlers.get(key) === handler) {
      handlers.delete(key);
    }
  };
}

/** Rejects work that no longer belongs to the active gateway lifecycle. */
export function assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration: string): void {
  if (isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
    return;
  }
  throw createAgentRunStaleLifecycleError();
}

/** Captures immutable lifecycle ownership for one admitted execution. */
export function captureAgentRunLifecycleGeneration(runId: string): string {
  return (
    getAgentEventExecutionContext().getStore()?.lifecycleGeneration ??
    getAgentRunContext(runId)?.lifecycleGeneration ??
    getAgentRunLifecycleGeneration()
  );
}

/** Starts a new ownership generation before an in-process gateway restart. */
export function rotateAgentEventLifecycleGeneration(): string {
  const state = getAgentEventState();
  const lifecycleGeneration = rotateAgentRunRegistryLifecycleGeneration();
  // Rotation is the liveness choke point: after it returns, no prior-generation
  // owner is operationally reachable. Recovery and runtime consumers therefore
  // agree that only current-generation owners can drive or receive work.
  const errors: unknown[] = [];
  notifyListeners(state.lifecycleRotationHandlers?.values() ?? [], lifecycleGeneration, (error) =>
    errors.push(error),
  );
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to retire stale agent lifecycle owners");
  }
  return lifecycleGeneration;
}

// Preserve the former activity window and the native worker identifier bound.
const MAX_EXECUTION_ACTIVITY_ITEMS = 64;
const MAX_EXECUTION_ACTIVITY_ID_LENGTH = 256;
const MAX_EXECUTION_TOOL_NAME_LENGTH = 120;

function activityId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const id = value.trim();
  return id && id.length <= MAX_EXECUTION_ACTIVITY_ID_LENGTH ? id : undefined;
}

function recordExecutionActivity(
  context: AgentRunContext,
  event: Omit<AgentEventPayload, "seq" | "ts">,
): void {
  if (
    (event.sessionKey && context.sessionKey && event.sessionKey !== context.sessionKey) ||
    (event.sessionId && context.sessionId && event.sessionId !== context.sessionId)
  ) {
    return;
  }
  const { stream, data } = event;
  if (stream === "lifecycle" && (data.phase === "end" || data.phase === "error")) {
    context.executionActivity = undefined;
    return;
  }
  const approval = stream === "execution" && isRecord(data.approval) ? data.approval : undefined;
  const approvalId = activityId(
    approval?.id ?? (stream === "lifecycle" ? data.approvalId : undefined),
  );
  const approvalState =
    approval?.state ??
    (data.phase === "waiting-approval"
      ? "pending"
      : data.phase === "approval-resolved"
        ? "resolved"
        : undefined);
  if (approvalId && (approvalState === "pending" || approvalState === "resolved")) {
    const activity = (context.executionActivity ??= { tools: [], pendingApprovalIds: [] });
    if (approvalState === "pending" && !activity.pendingApprovalIds.includes(approvalId)) {
      if (activity.pendingApprovalIds.length < MAX_EXECUTION_ACTIVITY_ITEMS) {
        activity.pendingApprovalIds.push(approvalId);
      } else {
        // Unrepresented approvals cannot be mistaken for a fully resumed run.
        activity.approvalOverflow = true;
      }
    } else if (approvalState === "resolved") {
      activity.pendingApprovalIds = activity.pendingApprovalIds.filter((id) => id !== approvalId);
    }
    return;
  }
  if (
    stream === "execution" &&
    (data.state === "running" || data.state === "waiting" || data.state === "unknown")
  ) {
    const sourceId = activityId(data.sourceId);
    const previous = context.executionActivity?.execution;
    if (data.invalidate === true && (!sourceId || previous?.sourceId !== sourceId)) {
      return;
    }
    const activity = (context.executionActivity ??= { tools: [], pendingApprovalIds: [] });
    const id = activityId(data.executionId);
    if (
      data.state === "unknown" ||
      (sourceId && previous?.sourceId !== sourceId) ||
      (id && previous?.id !== id)
    ) {
      activity.tools = [];
    }
    const kind = isRecord(data.wait) ? data.wait.kind : undefined;
    const wait =
      kind === "approval" ||
      kind === "user_input" ||
      kind === "agent_messages" ||
      kind === "children"
        ? kind
        : "external";
    activity.execution = {
      state: data.state,
      sourceId: sourceId ?? previous?.sourceId,
      id: id ?? previous?.id,
      ...(data.state === "waiting" ? { wait } : {}),
    };
    return;
  }
  if (stream !== "tool") {
    return;
  }
  const toolCallId = activityId(data.toolCallId);
  if (!toolCallId) {
    return;
  }
  const existing = context.executionActivity;
  if (data.phase === "result" || data.phase === "end") {
    if (existing) {
      existing.tools = existing.tools.filter((tool) => tool.id !== toolCallId);
    }
    return;
  }
  if (data.phase !== "start" || typeof data.name !== "string" || !data.name.trim()) {
    return;
  }
  const activity = (context.executionActivity ??= { tools: [], pendingApprovalIds: [] });
  const tool = {
    id: toolCallId,
    name: truncateUtf16Safe(data.name.trim(), MAX_EXECUTION_TOOL_NAME_LENGTH),
  };
  const index = activity.tools.findIndex((current) => current.id === toolCallId);
  if (index >= 0) {
    activity.tools[index] = tool;
  } else if (activity.tools.length < MAX_EXECUTION_ACTIVITY_ITEMS) {
    activity.tools.push(tool);
  }
}

function resolveAgentEventRouting(
  event: Pick<AgentEventPayload, "runId" | "lifecycleGeneration">,
  claimId?: string,
  expectedContext?: AgentRunContext,
) {
  const currentLifecycleGeneration = getAgentRunLifecycleGeneration();
  const owners = getAgentRunContextOwnership(event.runId);
  if (claimId !== undefined) {
    if (
      owners?.lifecycleGeneration !== currentLifecycleGeneration ||
      owners.exclusiveClaimId !== claimId ||
      !owners.claimIds.has(claimId) ||
      owners.clearRequested
    ) {
      return undefined;
    }
  } else if (
    owners?.lifecycleGeneration === currentLifecycleGeneration &&
    owners.exclusiveClaimId
  ) {
    return undefined;
  }
  const context = getAgentRunContext(event.runId);
  if (expectedContext && context !== expectedContext) {
    return undefined;
  }
  const scope = getAgentEventExecutionContext().getStore();
  const executionLifecycleGeneration = event.lifecycleGeneration ?? scope?.lifecycleGeneration;
  const ownedLifecycleGeneration = executionLifecycleGeneration ?? context?.lifecycleGeneration;
  if (
    executionLifecycleGeneration &&
    context?.lifecycleGeneration &&
    executionLifecycleGeneration !== context.lifecycleGeneration
  ) {
    return undefined;
  }
  if (ownedLifecycleGeneration && ownedLifecycleGeneration !== currentLifecycleGeneration) {
    return undefined;
  }
  const record = scope?.routingByRun?.get(event.runId);
  const captured =
    record?.routing.lifecycleGeneration === ownedLifecycleGeneration ? record : undefined;
  const capturedOwner = captured?.owner.deref();
  if (captured && context && capturedOwner !== context) {
    return undefined;
  }
  const routing = context ?? captured?.routing;
  return { context, routing, capturedOwner, ownedLifecycleGeneration, currentLifecycleGeneration };
}

function enrichAgentEvent(
  state: AgentEventState,
  event: Omit<AgentEventPayload, "seq" | "ts">,
  claimId?: string,
  expectedContext?: AgentRunContext,
  reservedPublication?: symbol,
  assistantSource?: AgentAssistantSourceReceipt,
  assistantProjection?: AgentAssistantProjection,
): AgentEventRuntimePayload | undefined {
  const resolved = resolveAgentEventRouting(event, claimId, expectedContext);
  if (!resolved || hasInvalidLifecycleStartTimestamp(event.stream, event.data)) {
    return undefined;
  }
  const { context, routing, capturedOwner, ownedLifecycleGeneration, currentLifecycleGeneration } =
    resolved;
  if (event.stream === "lifecycle" && event.data.phase === "model") {
    if (!context || (claimId === undefined && (expectedContext ?? capturedOwner) !== context)) {
      return undefined;
    }
    const { provider, model } = event.data;
    if (provider === null && model === null) {
      recordAgentRunModel(event.runId, undefined);
    } else if (
      typeof provider === "string" &&
      provider.trim() &&
      typeof model === "string" &&
      model.trim()
    ) {
      recordAgentRunModel(event.runId, { provider, model });
    } else {
      return undefined;
    }
  }
  const runState = routing?.eventState ?? state.runs.get(event.runId) ?? { seq: 0 };
  let data = event.data;
  if (routing && event.stream === "lifecycle") {
    if (routing.completionSource) {
      data = { ...data, completionSource: routing.completionSource };
    }
    if (data.phase === "start") {
      if (context) {
        context.lifecycleStartedAt = data.startedAt as number;
      }
    } else if (
      (data.phase === "end" || data.phase === "error") &&
      data.startedAt === undefined &&
      routing.lifecycleStartedAt !== undefined
    ) {
      // Preserve this run's identity after a newer run takes over its session.
      data = { ...data, startedAt: routing.lifecycleStartedAt };
    }
  }
  if (context) {
    recordAgentEventRouting(event.runId, context);
  }
  const nextSeq = Math.max(runState.seq, state.runs.get(event.runId)?.seq ?? 0) + 1;
  runState.seq = nextSeq;
  state.runs.set(event.runId, runState);
  if (context) {
    context.lastActiveAt = Date.now();
    recordExecutionActivity(context, event);
  }
  const isControlUiVisible = routing?.isControlUiVisible ?? true;
  const eventSessionKey =
    typeof event.sessionKey === "string" && event.sessionKey.trim() ? event.sessionKey : undefined;
  // Hidden subscribers retain owner-bound routing without exposing a public session key.
  const deliverySessionKey =
    claimId !== undefined
      ? (eventSessionKey ?? routing?.sessionKey)
      : !isControlUiVisible && event.stream !== "lifecycle"
        ? routing?.sessionKey
        : undefined;
  // Hidden channel-routed runs should not leak live assistant/tool traffic into
  // Control UI, but lifecycle events still need the session key so gateway
  // listeners can persist terminal session state even if run-context lookup is
  // unavailable by the time the terminal event arrives. Terminal failures are
  // emitted on the lifecycle stream with `phase: "error"`; the separate error
  // stream remains redacted for hidden runs because it is observational only.
  const preserveSessionKey = isControlUiVisible || event.stream === "lifecycle";
  const sessionKey = preserveSessionKey ? (eventSessionKey ?? routing?.sessionKey) : undefined;
  // Stamp lifecycle events with the owning sessionId (see AgentEventPayload) at
  // emit time, since the run context can be cleared before the terminal persists.
  const sessionId =
    event.stream === "lifecycle" ? (event.sessionId ?? routing?.sessionId) : event.sessionId;
  const lifecycleGeneration =
    event.stream === "lifecycle"
      ? (ownedLifecycleGeneration ?? currentLifecycleGeneration)
      : ownedLifecycleGeneration;
  const agentId = event.agentId ?? routing?.agentId;
  const enriched: AgentEventRuntimePayload = {
    ...event,
    data,
    sessionKey,
    ...(sessionId ? { sessionId } : {}),
    ...(agentId ? { agentId } : {}),
    seq: nextSeq,
    ts: Date.now(),
  };
  if (event.stream === "lifecycle") {
    // A listener can synchronously emit a terminal before this event reaches the publisher.
    // Internal settlement observers consume the event without claiming publication.
    const publication = reservedPublication ?? Symbol("agent lifecycle publication");
    let consumed = false;
    Object.defineProperty(enriched, "admitLifecyclePublication", {
      value: () => {
        if (
          consumed ||
          (runState.terminalPublication && runState.terminalPublication !== publication)
        ) {
          return false;
        }
        consumed = true;
        if (isDefinitiveRunLifecycle({ phase: data.phase, data })) {
          runState.terminalPublication = publication;
        }
        return true;
      },
    });
  }
  Object.defineProperties(enriched, {
    assistantSource: { value: assistantSource, enumerable: false },
    assistantProjection: { value: assistantProjection, enumerable: false },
  });
  if (lifecycleGeneration) {
    // Persistence needs restart ownership, but agent events are also spread into
    // public payloads. Keep the internal generation readable without serializing it.
    Object.defineProperty(enriched, "lifecycleGeneration", {
      value: lifecycleGeneration,
      enumerable: false,
    });
  }
  for (const [key, source] of AGENT_EVENT_ROUTING_FIELDS) {
    const value = routing?.[source];
    if (value !== undefined) {
      Object.defineProperty(enriched, key, { value, enumerable: false });
    }
  }
  if (claimId !== undefined) {
    Object.defineProperty(enriched, "contextClaimId", {
      value: claimId,
      enumerable: false,
    });
  }
  if (deliverySessionKey) {
    Object.defineProperty(enriched, "deliverySessionKey", {
      value: deliverySessionKey,
      enumerable: false,
    });
  }
  return enriched;
}

function* iterateAgentEventListeners(
  state: AgentEventState,
  enriched: AgentEventRuntimePayload,
  deliveries: ReadonlyMap<AgentEventRegistration, () => boolean>,
): Generator<AgentEventListener, void> {
  let lastId = -1;
  let revision = -1;
  let runId: string | undefined;
  let globalRegistrations: MapIterator<AgentEventRegistration> | undefined;
  let runRegistrations: MapIterator<AgentEventRegistration> | undefined;
  let global: AgentEventRegistration | undefined;
  let scoped: AgentEventRegistration | undefined;
  while (true) {
    const currentRunId = enriched.runId;
    // Recheck even after the last yield: the original live Set sees additions,
    // deletions, and re-additions made by a callback. Each nested emit owns its cursor.
    if (revision !== state.listenerRevision || runId !== currentRunId) {
      revision = state.listenerRevision;
      runId = currentRunId;
      // Registration IDs follow Map insertion order. Restart both cursors when
      // a callback mutates registration or selects a different run cohort.
      globalRegistrations = state.listeners.values();
      runRegistrations = state.runListeners.get(runId)?.values();
      global = globalRegistrations.next().value;
      scoped = runRegistrations?.next().value;
    }
    while (global && global.id <= lastId) {
      global = globalRegistrations?.next().value;
    }
    while (scoped && scoped.id <= lastId) {
      scoped = runRegistrations?.next().value;
    }
    const next = global && (!scoped || global.id <= scoped.id) ? global : scoped;
    if (!next) {
      return;
    }
    lastId = next.id;
    yield next.captureDelivery
      ? (event) => {
          const isDeliveryCurrent = deliveries.get(next);
          if (isDeliveryCurrent?.()) {
            next.listener(event, isDeliveryCurrent);
          }
        }
      : next.listener;
  }
}

function dispatchAgentEvent(
  event: Omit<AgentEventPayload, "seq" | "ts">,
  claimId?: string,
  expectedContext?: AgentRunContext,
  reservedPublication?: symbol,
  assistantSource?: AgentAssistantSourceReceipt,
  assistantProjection?: AgentAssistantProjection,
): boolean {
  const state = getAgentEventState();
  const enriched = enrichAgentEvent(
    state,
    event,
    claimId,
    expectedContext,
    reservedPublication,
    assistantSource,
    assistantProjection,
  );
  if (!enriched) {
    return false;
  }
  const deliveries = new Map<AgentEventRegistration, () => boolean>();
  // Capture registrations before callbacks can replace them. New subscriptions
  // during this emission have no captured delivery authority until the next event.
  notifyListeners(
    Array.from(state.listeners.values(), (registration) => () => {
      if (registration.captureDelivery) {
        deliveries.set(registration, registration.captureDelivery(enriched));
      }
    }),
    enriched,
  );
  notifyListeners(iterateAgentEventListeners(state, enriched, deliveries), enriched);
  return true;
}

/** Emits an event only when its run ownership is still current. */
export function emitAgentEventIfCurrent(event: Omit<AgentEventPayload, "seq" | "ts">): boolean {
  return dispatchAgentEvent(event);
}

/** Bind the source occurrence only after ordinary event ownership admission. */
export function emitAgentEventWithAssistantSourceIfCurrent(
  event: Omit<AgentEventPayload, "seq" | "ts">,
  assistantSource: AgentAssistantSourceReceipt | undefined,
  assistantProjection?: AgentAssistantProjection,
): boolean {
  return dispatchAgentEvent(
    event,
    undefined,
    undefined,
    undefined,
    assistantSource,
    assistantProjection,
  );
}

/** Adds one completed model call, returning its accepted run total for local callbacks. */
export function emitAgentRunOutputTokens(params: {
  runId: string;
  lifecycleGeneration: string;
  outputTokens: number;
  sessionKey?: string;
}): { outputTokens: number } | undefined {
  return recordAgentRunOutputTokens({
    ...params,
    emit: (data) =>
      emitAgentEventIfCurrent({
        runId: params.runId,
        lifecycleGeneration: params.lifecycleGeneration,
        sessionKey: params.sessionKey,
        stream: "usage",
        data,
      }),
  });
}

/** Emits an agent event after assigning per-run sequence, timestamp, and context metadata. */
export function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  emitAgentEventIfCurrent(event);
}

export function emitAgentEventForOwner(
  event: Omit<AgentEventPayload, "seq" | "ts">,
  claimId: string,
) {
  dispatchAgentEvent(event, claimId);
}

/** Emits only while the exact run-context record captured by its producer remains current. */
export function emitAgentEventForRunContext(
  event: Omit<AgentEventPayload, "seq" | "ts">,
  context: AgentRunContext,
) {
  dispatchAgentEvent(event, undefined, context);
}

/** Emits run metadata only to the Gateway-owned durable audit projection. */
export function emitAgentAuditEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  const state = getAgentEventState();
  const enriched = enrichAgentEvent(state, event);
  if (enriched) {
    notifyListeners(state.auditListeners, enriched);
    const phase = event.stream === "lifecycle" ? event.data.phase : undefined;
    if ((phase === "end" || phase === "error") && !getAgentRunContext(event.runId)) {
      // Private synthetic runs bypass public terminal cleanup. Release sequence state only
      // after synchronous audit listeners consume the terminal event and its final ordering.
      state.runs.delete(event.runId);
    }
  }
}

/** Subscribes to sequenced agent events; returns an unsubscribe callback. */
export function onAgentEvent(listener: (evt: AgentEventPayload) => void) {
  return registerAgentEventListener(listener);
}

/** Subscribes Gateway internals that consume non-public ownership and routing metadata. */
export function onAgentRuntimeEvent(
  listener: AgentEventListener,
  captureDelivery?: CaptureAgentEventDelivery,
) {
  return registerAgentEventListener(listener, undefined, captureDelivery);
}

/**
 * Subscribes to one run's sequenced agent events; returns an unsubscribe callback.
 * Prefer this over `onAgentEvent` for a listener that discards other runs: those
 * listeners otherwise run on every concurrent run's events.
 */
export function onAgentEventForRun(runId: string, listener: (evt: AgentEventPayload) => void) {
  return registerAgentEventListener(listener, runId);
}

function registerAgentEventListener(
  listener: AgentEventListener,
  runId?: string,
  captureDelivery?: CaptureAgentEventDelivery,
) {
  const state = getAgentEventState();
  const bucket: AgentEventListeners =
    runId === undefined ? state.listeners : (state.runListeners.get(runId) ?? new Map());
  if (!bucket.has(listener)) {
    bucket.set(listener, { listener, id: state.nextListenerId++, captureDelivery });
    if (runId !== undefined) {
      state.runListeners.set(runId, bucket);
    }
    state.listenerRevision++;
  }
  return () => {
    if (bucket.delete(listener)) {
      state.listenerRevision++;
    }
    // Only reclaim the bucket this handle registered into; a later subscriber
    // for the same run may already have installed a replacement.
    if (runId !== undefined && bucket.size === 0 && state.runListeners.get(runId) === bucket) {
      state.runListeners.delete(runId);
    }
  };
}

/** Subscribes to private audit-only agent events; returns an unsubscribe callback. */
export function onAgentAuditEvent(listener: (evt: AgentEventPayload) => void) {
  return registerListener(getAgentEventState().auditListeners, listener);
}

/** Clears agent event state; test suites with a live Gateway can preserve its listeners. */
export function resetAgentEventsForTest(options?: { preserveListeners?: boolean }) {
  const state = getAgentEventState();
  state.runs.clear();
  resetAgentRunRegistryForTest();
  if (!options?.preserveListeners) {
    state.listeners.clear();
    for (const bucket of state.runListeners.values()) {
      bucket.clear();
    }
    state.runListeners.clear();
    state.auditListeners.clear();
    // Do not reuse IDs: an active dispatch resumes strictly after its last yield.
    state.listenerRevision++;
  }
}
