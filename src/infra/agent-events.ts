// Stores and broadcasts agent lifecycle and streaming events.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { VerboseLevel } from "../auto-reply/thinking.js";
import { createAbortError } from "./abort-signal.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

/** Stream name for agent events delivered to gateway listeners and plugin host hooks. */
export type AgentEventStream =
  | "lifecycle"
  | "tool"
  | "assistant"
  | "error"
  | "item"
  | "plan"
  | "approval"
  | "command_output"
  | "patch"
  | "compaction"
  | "thinking"
  | (string & {});

/** Lifecycle phase for a visible item in the agent activity feed. */
export type AgentItemEventPhase = "start" | "update" | "end";
/** Status rendered for an item-level agent activity event. */
export type AgentItemEventStatus = "running" | "completed" | "failed" | "blocked";
/** Item category used by channels and Control UI to choose progress presentation. */
export type AgentItemEventKind =
  | "tool"
  | "command"
  | "patch"
  | "search"
  | "analysis"
  | (string & {});

/** Payload for a single item shown in the agent activity stream. */
export type AgentItemEventData = {
  itemId: string;
  phase: AgentItemEventPhase;
  kind: AgentItemEventKind;
  title: string;
  status: AgentItemEventStatus;
  name?: string;
  meta?: string;
  toolCallId?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  summary?: string;
  progressText?: string;
  /** Preserve item telemetry while letting channel progress render a sibling tool event instead. */
  suppressChannelProgress?: boolean;
  approvalId?: string;
  approvalSlug?: string;
};

/** Approval event phase for request/resolution transitions. */
export type AgentApprovalEventPhase = "requested" | "resolved";
/** Approval status after routing, user action, or delivery failure. */
export type AgentApprovalEventStatus = "pending" | "unavailable" | "approved" | "denied" | "failed";
/** Approval family used by renderers and host hooks. */
export type AgentApprovalEventKind = "exec" | "plugin" | "unknown";

/** Payload for approval requests and their later resolution events. */
export type AgentApprovalEventData = {
  phase: AgentApprovalEventPhase;
  kind: AgentApprovalEventKind;
  status: AgentApprovalEventStatus;
  title: string;
  itemId?: string;
  toolCallId?: string;
  approvalId?: string;
  approvalSlug?: string;
  command?: string;
  host?: string;
  reason?: string;
  scope?: "turn" | "session";
  message?: string;
};

/** Incremental command output payload associated with an item/tool call. */
export type AgentCommandOutputEventData = {
  itemId: string;
  phase: "delta" | "end";
  title: string;
  toolCallId: string;
  name?: string;
  output?: string;
  status?: AgentItemEventStatus | "running";
  exitCode?: number | null;
  durationMs?: number;
  cwd?: string;
};

/** Patch summary payload emitted after an agent applies file changes. */
export type AgentPatchSummaryEventData = {
  itemId: string;
  phase: "end";
  title: string;
  toolCallId: string;
  name?: string;
  added: string[];
  modified: string[];
  deleted: string[];
  summary: string;
};

/** Enriched event delivered to subscribers after sequencing and context stamping. */
export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  data: Record<string, unknown>;
  /** Internal, non-enumerable gateway lifecycle generation that owns this run. */
  lifecycleGeneration?: string;
  sessionKey?: string;
  /**
   * sessionId the run was bound to when it started. Lifecycle persistence uses
   * this to reject terminal events from a pre-`sessions.reset` run that would
   * otherwise clobber the rotated session row resolved by the shared sessionKey.
   */
  sessionId?: string;
  agentId?: string;
};

/** Per-run metadata used to stamp events and gate Control UI visibility. */
export type AgentRunContext = {
  sessionKey?: string;
  /** Owning run's sessionId; stamped onto lifecycle events (see AgentEventPayload.sessionId). */
  sessionId?: string;
  /** Gateway lifecycle generation captured when the run was registered. */
  lifecycleGeneration?: string;
  verboseLevel?: VerboseLevel;
  isHeartbeat?: boolean;
  /** Whether control UI clients should receive chat/agent updates for this run. */
  isControlUiVisible?: boolean;
  /** Timestamp when this context was first registered (for TTL-based cleanup). */
  registeredAt?: number;
  /** Timestamp of last activity (updated on every emitAgentEvent). */
  lastActiveAt?: number;
};

type AgentEventState = {
  seqByRun: Map<string, number>;
  listeners: Set<(evt: AgentEventPayload) => void>;
  runContextById: Map<string, AgentRunContext>;
  runContextOwnersById?: Map<
    string,
    {
      lifecycleGeneration: string;
      ownerTokens: Set<string>;
      preserveAfterRelease: boolean;
      clearRequested: boolean;
    }
  >;
  lifecycleGeneration: string;
};

const AGENT_EVENT_STATE_KEY = Symbol.for("openclaw.agentEvents.state");
const AGENT_EVENT_EXECUTION_CONTEXT_KEY = Symbol.for("openclaw.agentEvents.executionContext");

type AgentEventExecutionContext = {
  lifecycleGeneration: string;
};

function getAgentEventState(): AgentEventState {
  return resolveGlobalSingleton<AgentEventState>(AGENT_EVENT_STATE_KEY, () => ({
    seqByRun: new Map<string, number>(),
    listeners: new Set<(evt: AgentEventPayload) => void>(),
    runContextById: new Map<string, AgentRunContext>(),
    lifecycleGeneration: randomUUID(),
  }));
}

function getAgentEventExecutionContext() {
  return resolveGlobalSingleton<AsyncLocalStorage<AgentEventExecutionContext>>(
    AGENT_EVENT_EXECUTION_CONTEXT_KEY,
    () => new AsyncLocalStorage<AgentEventExecutionContext>(),
  );
}

/** Runs one execution with immutable ownership inherited by every emitted stream event. */
export function withAgentRunLifecycleGeneration<T>(lifecycleGeneration: string, run: () => T): T {
  return getAgentEventExecutionContext().run({ lifecycleGeneration }, run);
}

export function getAgentEventLifecycleGeneration(): string {
  return getAgentEventState().lifecycleGeneration;
}

/** Rejects work that no longer belongs to the active gateway lifecycle. */
export function assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration: string): void {
  if (lifecycleGeneration === getAgentEventState().lifecycleGeneration) {
    return;
  }
  throw createAbortError("Agent run belongs to a stale gateway lifecycle");
}

/** Captures immutable lifecycle ownership for one admitted execution. */
export function captureAgentRunLifecycleGeneration(runId: string): string {
  return (
    getAgentEventExecutionContext().getStore()?.lifecycleGeneration ??
    getAgentEventState().runContextById.get(runId)?.lifecycleGeneration ??
    getAgentEventState().lifecycleGeneration
  );
}

/** Starts a new ownership generation before an in-process gateway restart. */
export function rotateAgentEventLifecycleGeneration(): string {
  const state = getAgentEventState();
  state.lifecycleGeneration = randomUUID();
  return state.lifecycleGeneration;
}

/** Registers or merges per-run context used by later agent event emissions. */
export function registerAgentRunContext(runId: string, context: AgentRunContext) {
  if (!runId) {
    return;
  }
  const state = getAgentEventState();
  const existing = state.runContextById.get(runId);
  if (!existing) {
    state.runContextById.set(runId, {
      ...context,
      lifecycleGeneration: context.lifecycleGeneration ?? state.lifecycleGeneration,
      registeredAt: context.registeredAt ?? Date.now(),
    });
    return;
  }
  if (
    context.lifecycleGeneration &&
    existing.lifecycleGeneration &&
    context.lifecycleGeneration !== existing.lifecycleGeneration
  ) {
    return;
  }
  if (context.sessionKey && existing.sessionKey !== context.sessionKey) {
    existing.sessionKey = context.sessionKey;
  }
  if (context.sessionId && existing.sessionId !== context.sessionId) {
    existing.sessionId = context.sessionId;
  }
  if (context.verboseLevel && existing.verboseLevel !== context.verboseLevel) {
    existing.verboseLevel = context.verboseLevel;
  }
  if (context.isControlUiVisible !== undefined) {
    existing.isControlUiVisible = context.isControlUiVisible;
  }
  if (context.isHeartbeat !== undefined && existing.isHeartbeat !== context.isHeartbeat) {
    existing.isHeartbeat = context.isHeartbeat;
  }
  if (context.registeredAt !== undefined) {
    existing.registeredAt = context.registeredAt;
  }
  if (context.lastActiveAt !== undefined) {
    existing.lastActiveAt = context.lastActiveAt;
  }
}

function getAgentRunContextOwners(state = getAgentEventState()) {
  state.runContextOwnersById ??= new Map();
  return state.runContextOwnersById;
}

/** Claims a run id for a newly admitted execution, replacing stale ownership. */
export function claimAgentRunContext(
  runId: string,
  context: AgentRunContext,
  options: { trackOwner?: boolean; ownsContext?: boolean } = {},
): string | undefined {
  if (!runId) {
    return undefined;
  }
  const state = getAgentEventState();
  const lifecycleGeneration = context.lifecycleGeneration ?? state.lifecycleGeneration;
  const existing = state.runContextById.get(runId);
  const ownersById = getAgentRunContextOwners(state);
  const existingOwners = ownersById.get(runId);
  let ownerToken: string | undefined;
  if (options.trackOwner) {
    ownerToken = randomUUID();
    if (existingOwners?.lifecycleGeneration === lifecycleGeneration) {
      existingOwners.ownerTokens.add(ownerToken);
      if (options.ownsContext) {
        existingOwners.preserveAfterRelease = false;
      }
    } else {
      ownersById.set(runId, {
        lifecycleGeneration,
        ownerTokens: new Set([ownerToken]),
        preserveAfterRelease:
          options.ownsContext !== true && existing?.lifecycleGeneration === lifecycleGeneration,
        clearRequested: false,
      });
    }
  } else if (existingOwners?.lifecycleGeneration !== lifecycleGeneration) {
    // Same-generation untracked claims refresh metadata inside the tracked
    // execution. A new lifecycle replaces that ownership outright.
    ownersById.delete(runId);
  }
  if (existing?.lifecycleGeneration === lifecycleGeneration) {
    registerAgentRunContext(runId, {
      ...context,
      lifecycleGeneration,
    });
    return ownerToken;
  }
  state.runContextById.set(runId, {
    ...context,
    lifecycleGeneration,
    registeredAt: context.registeredAt ?? Date.now(),
  });
  state.seqByRun.delete(runId);
  return ownerToken;
}

/** Returns the currently registered context for a run, if it has not been cleared or swept. */
export function getAgentRunContext(runId: string) {
  return getAgentEventState().runContextById.get(runId);
}

/** Lists active runs bound to one current session identity. */
export function listAgentRunsForSession(params: {
  sessionKey: string;
  sessionId?: string;
}): Array<{ runId: string; lifecycleGeneration: string }> {
  const currentLifecycleGeneration = getAgentEventState().lifecycleGeneration;
  const runs: Array<{ runId: string; lifecycleGeneration: string }> = [];
  for (const [runId, context] of getAgentEventState().runContextById) {
    const matches = context.sessionId
      ? context.sessionId === params.sessionId
      : context.sessionKey === params.sessionKey;
    if (matches && context.lifecycleGeneration === currentLifecycleGeneration) {
      runs.push({ runId, lifecycleGeneration: context.lifecycleGeneration });
    }
  }
  return runs.toSorted((a, b) =>
    a.runId === b.runId
      ? a.lifecycleGeneration.localeCompare(b.lifecycleGeneration)
      : a.runId.localeCompare(b.runId),
  );
}

/** Clears context and sequence state for a run that has ended or been discarded. */
export function clearAgentRunContext(runId: string, lifecycleGeneration?: string) {
  const state = getAgentEventState();
  const existing = state.runContextById.get(runId);
  if (lifecycleGeneration && existing && existing.lifecycleGeneration !== lifecycleGeneration) {
    return;
  }
  const owners = getAgentRunContextOwners(state).get(runId);
  if (owners?.ownerTokens.size) {
    if (!lifecycleGeneration || owners.lifecycleGeneration === lifecycleGeneration) {
      owners.clearRequested = true;
    }
    return;
  }
  state.runContextById.delete(runId);
  state.seqByRun.delete(runId);
}

/** Releases one tracked owner and clears its context after the final owner exits. */
export function releaseAgentRunContext(runId: string, ownerToken: string | undefined) {
  if (!runId || !ownerToken) {
    return;
  }
  const state = getAgentEventState();
  const ownersById = getAgentRunContextOwners(state);
  const owners = ownersById.get(runId);
  if (!owners?.ownerTokens.delete(ownerToken)) {
    return;
  }
  if (owners.ownerTokens.size > 0) {
    return;
  }
  ownersById.delete(runId);
  if (owners.clearRequested || !owners.preserveAfterRelease) {
    clearAgentRunContext(runId, owners.lifecycleGeneration);
  }
}

/**
 * Sweep stale run contexts that exceeded the given TTL.
 * Guards against orphaned entries when lifecycle "end"/"error" events are missed.
 */
export function sweepStaleRunContexts(maxAgeMs = 30 * 60 * 1000): number {
  const state = getAgentEventState();
  const now = Date.now();
  let swept = 0;
  for (const [runId, ctx] of state.runContextById.entries()) {
    // Use lastActiveAt (refreshed on every event) to avoid sweeping active runs.
    // Fall back to registeredAt, then treat missing timestamps as infinitely old.
    const lastSeen = ctx.lastActiveAt ?? ctx.registeredAt;
    const age = lastSeen ? now - lastSeen : Infinity;
    if (age > maxAgeMs) {
      state.runContextById.delete(runId);
      state.seqByRun.delete(runId);
      getAgentRunContextOwners(state).delete(runId);
      swept++;
    }
  }
  return swept;
}

/** Clears run context state without removing event listeners; test-only helper. */
export function resetAgentRunContextForTest() {
  const state = getAgentEventState();
  state.runContextById.clear();
  state.seqByRun.clear();
  getAgentRunContextOwners(state).clear();
}

/** Emits an agent event after assigning per-run sequence, timestamp, and context metadata. */
export function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  const state = getAgentEventState();
  const context = state.runContextById.get(event.runId);
  const executionLifecycleGeneration =
    event.lifecycleGeneration ?? getAgentEventExecutionContext().getStore()?.lifecycleGeneration;
  const ownedLifecycleGeneration = executionLifecycleGeneration ?? context?.lifecycleGeneration;
  if (
    executionLifecycleGeneration &&
    context?.lifecycleGeneration &&
    executionLifecycleGeneration !== context.lifecycleGeneration
  ) {
    return;
  }
  if (ownedLifecycleGeneration && ownedLifecycleGeneration !== state.lifecycleGeneration) {
    return;
  }
  const nextSeq = (state.seqByRun.get(event.runId) ?? 0) + 1;
  state.seqByRun.set(event.runId, nextSeq);
  if (context) {
    context.lastActiveAt = Date.now();
  }
  const isControlUiVisible = context?.isControlUiVisible ?? true;
  const eventSessionKey =
    typeof event.sessionKey === "string" && event.sessionKey.trim() ? event.sessionKey : undefined;
  // Hidden channel-routed runs should not leak live assistant/tool traffic into
  // Control UI, but lifecycle events still need the session key so gateway
  // listeners can persist terminal session state even if run-context lookup is
  // unavailable by the time the terminal event arrives. Terminal failures are
  // emitted on the lifecycle stream with `phase: "error"`; the separate error
  // stream remains redacted for hidden runs because it is observational only.
  const preserveSessionKey = isControlUiVisible || event.stream === "lifecycle";
  const sessionKey = preserveSessionKey ? (eventSessionKey ?? context?.sessionKey) : undefined;
  // Stamp lifecycle events with the owning sessionId (see AgentEventPayload) at
  // emit time, since the run context can be cleared before the terminal persists.
  const sessionId =
    event.stream === "lifecycle" ? (event.sessionId ?? context?.sessionId) : event.sessionId;
  const lifecycleGeneration =
    event.stream === "lifecycle"
      ? (ownedLifecycleGeneration ?? state.lifecycleGeneration)
      : ownedLifecycleGeneration;
  const enriched: AgentEventPayload = {
    ...event,
    sessionKey,
    ...(sessionId ? { sessionId } : {}),
    seq: nextSeq,
    ts: Date.now(),
  };
  if (lifecycleGeneration) {
    // Persistence needs restart ownership, but agent events are also spread into
    // public payloads. Keep the internal generation readable without serializing it.
    Object.defineProperty(enriched, "lifecycleGeneration", {
      value: lifecycleGeneration,
      enumerable: false,
    });
  }
  notifyListeners(state.listeners, enriched);
}

/** Emits an item activity event on the shared agent event bus. */
export function emitAgentItemEvent(params: {
  runId: string;
  data: AgentItemEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "item",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

/** Emits an approval event on the shared agent event bus. */
export function emitAgentApprovalEvent(params: {
  runId: string;
  data: AgentApprovalEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "approval",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

/** Emits command output for a running or completed item/tool call. */
export function emitAgentCommandOutputEvent(params: {
  runId: string;
  data: AgentCommandOutputEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "command_output",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

/** Emits a patch summary for a completed file-editing item/tool call. */
export function emitAgentPatchSummaryEvent(params: {
  runId: string;
  data: AgentPatchSummaryEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "patch",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

/** Subscribes to sequenced agent events; returns an unsubscribe callback. */
export function onAgentEvent(listener: (evt: AgentEventPayload) => void) {
  const state = getAgentEventState();
  return registerListener(state.listeners, listener);
}

/** Clears all agent event state, including listeners; test-only helper. */
export function resetAgentEventsForTest() {
  const state = getAgentEventState();
  state.seqByRun.clear();
  state.listeners.clear();
  state.runContextById.clear();
  getAgentRunContextOwners(state).clear();
}
