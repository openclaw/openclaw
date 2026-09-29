import type { AgentPlanStep } from "../channels/streaming.js";
// Gateway chat run state registries.
// Tracks active runs, delta buffers, tool recipients, and session subscribers.
import type { AgentEventPayload } from "../infra/agent-events.js";
import { mergeAssistantText, type AssistantTextSnapshot } from "./agent-event-assistant-text.js";
import type { ChatCanvasBlock } from "./chat-display-projection.canvas.js";
import {
  attachLiveAssistantItemScope,
  capLiveAssistantText,
  createLiveAssistantTextProjection,
  projectLiveAssistantBufferDelta,
  projectLiveAssistantBufferedText,
  refreshLiveItemOffsetCache,
  type LiveAssistantBufferDelta,
  type LiveAssistantBufferedProjection,
  type LiveAssistantDisplayState,
} from "./live-chat-projector.js";
import type { ChatRunProgressSnapshot } from "./server-chat-progress-snapshot.js";
import { updateChatRunProgressSnapshot } from "./server-chat-progress-snapshot.js";

export type ChatRunTiming = {
  ackedAtMs: number;
  connId: string;
  dispatchStartedAtMs?: number;
  firstAssistantEventSent?: boolean;
  receivedAtMs: number;
};

export type ChatRunRegistration = {
  sessionKey: string;
  agentId?: string;
  clientRunId: string;
  chatSendTiming?: ChatRunTiming;
};

export type ChatRunEntry = ChatRunRegistration & {
  registeredSequence: number;
};

export type ChatAbortMarker = { abortedAtMs: number; sequence: number };

let chatRunOrderingSequence = 0;

function nextChatRunOrderingSequence(): number {
  chatRunOrderingSequence += 1;
  return chatRunOrderingSequence;
}

/** Create an abort marker ordered against chat run registrations, using a shared monotonic sequence. */
export function createChatAbortMarker(now = Date.now()): ChatAbortMarker {
  return { abortedAtMs: now, sequence: nextChatRunOrderingSequence() };
}

/** Return the wall-clock timestamp used by maintenance TTL pruning. */
export function chatAbortMarkerTimestampMs(marker: ChatAbortMarker): number {
  return marker.abortedAtMs;
}

/**
 * Return whether an abort marker should suppress events for the given chat run registration.
 * The shared monotonic sequence keeps same-millisecond aborts ordered; a missing
 * entry preserves suppress-on-presence behavior.
 */
export function isChatAbortMarkerCurrent(
  marker: ChatAbortMarker | undefined,
  entry?: Pick<ChatRunEntry, "registeredSequence">,
): boolean {
  if (marker === undefined) {
    return false;
  }
  return !entry || marker.sequence >= entry.registeredSequence;
}

export type BufferedAgentEvent = {
  sessionKey?: string;
  agentId?: string;
  controlUiVisible?: boolean;
  isCurrent?: () => boolean;
  payload: AgentEventPayload & { spawnedBy?: string };
};

export type ChatRunPlanSnapshot = {
  steps: AgentPlanStep[];
  explanation?: string;
};

type ChatRunAgentTextState = {
  lastSentAt?: number;
  bufferedEvent?: BufferedAgentEvent;
  snapshot?: { text: string; itemId?: string };
};

type ChatRunToolRecipientState = {
  connIds: Set<string>;
  updatedAt: number;
  finalizedAt?: number;
};

type PendingLiveTextFlush = {
  timer: NodeJS.Timeout;
  flush: () => void;
};

type ChatRunRecord = {
  lastActivityAt: number;
  registrations?: ChatRunEntry[];
  rawBuffer?: string;
  buffer?: string;
  bufferIsCurrent?: () => boolean;
  /** Retire queued connection snapshots when this buffering generation is cleared. */
  liveTextGroup?: AbortController;
  liveTextEpoch?: object;
  display?: LiveAssistantDisplayState;
  planSnapshot?: ChatRunPlanSnapshot;
  progressSnapshot?: ChatRunProgressSnapshot;
  canvasBlocks?: ChatCanvasBlock[];
  deltaSentAt?: number;
  assistantScope?: AssistantTextSnapshot["scope"];
  managedMediaUrls?: Set<string>;
  agentText?: Partial<
    Record<"assistant" | "thinking" | "preamble" | "answer_candidate", ChatRunAgentTextState>
  >;
  abortMarker?: ChatAbortMarker;
  toolRecipient?: ChatRunToolRecipientState;
  /** Fixed-deadline trailing wake-up owned by this run's buffered state. */
  pendingTextFlushes?: Partial<Record<"chat" | "agent", PendingLiveTextFlush>>;
};

type ChatRunRecordStore = {
  runs: Map<string, ChatRunRecord>;
  getOrCreate: (runId: string) => ChatRunRecord;
  releaseIfEmpty: (runId: string) => void;
};

function createChatRunRecordStore(): ChatRunRecordStore {
  const runs = new Map<string, ChatRunRecord>();
  const getOrCreate = (runId: string) => {
    const existing = runs.get(runId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return existing;
    }
    const record: ChatRunRecord = { lastActivityAt: Date.now() };
    runs.set(runId, record);
    return record;
  };
  const releaseIfEmpty = (runId: string) => {
    const record = runs.get(runId);
    // Activity metadata alone does not retain a run.
    if (!record || Object.keys(record).length > 1) {
      return;
    }
    runs.delete(runId);
  };
  return { runs, getOrCreate, releaseIfEmpty };
}

function clearPendingLiveTextFlushes(record: ChatRunRecord): void {
  for (const pending of Object.values(record.pendingTextFlushes ?? {})) {
    clearTimeout(pending.timer);
  }
  delete record.pendingTextFlushes;
}

export type ChatRunRegistry = {
  add: (sessionId: string, entry: ChatRunRegistration) => void;
  peek: (sessionId: string) => ChatRunEntry | undefined;
  shift: (sessionId: string) => ChatRunEntry | undefined;
  remove: (sessionId: string, clientRunId: string, sessionKey?: string) => ChatRunEntry | undefined;
};

function createChatRunRegistryForStore(store: ChatRunRecordStore): ChatRunRegistry {
  const add = (sessionId: string, entry: ChatRunRegistration) => {
    const registeredEntry = { ...entry, registeredSequence: nextChatRunOrderingSequence() };
    const record = store.getOrCreate(sessionId);
    (record.registrations ??= []).push(registeredEntry);
  };

  const peek = (sessionId: string) => store.runs.get(sessionId)?.registrations?.[0];

  const takeRegistration = (sessionId: string, clientRunId?: string, sessionKey?: string) => {
    const record = store.runs.get(sessionId);
    if (!record) {
      return undefined;
    }
    const queue = record.registrations;
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const idx =
      clientRunId === undefined
        ? 0
        : queue.findIndex(
            (entry) =>
              entry.clientRunId === clientRunId && (!sessionKey || entry.sessionKey === sessionKey),
          );
    if (idx < 0) {
      return undefined;
    }
    const [entry] = queue.splice(idx, 1);
    if (!queue.length) {
      delete record.registrations;
      store.releaseIfEmpty(sessionId);
    }
    return entry;
  };

  return { add, peek, shift: (sessionId) => takeRegistration(sessionId), remove: takeRegistration };
}

export type ChatRunState = {
  runs: Map<string, ChatRunRecord>;
  registry: ChatRunRegistry;
  toolEventRecipients: ToolEventRecipientRegistry;
  /** Acquire mutable state and record activity; readers use runs.get. */
  getOrCreate: (runId: string) => ChatRunRecord;
  resolveBuffer: (runId: string, options?: { final?: boolean }) => LiveAssistantBufferedProjection;
  updateBuffer: (runId: string, input: Parameters<typeof mergeAssistantText>[1]) => string;
  takeBufferDelta: (runId: string, text: string) => LiveAssistantBufferDelta | undefined;
  flushPendingText: (runId: string) => void;
  hasAbortMarker: (runId: string) => boolean;
  deleteAbortMarker: (runId: string) => void;
  recordProgressEvent: (runId: string, event: AgentEventPayload, mode?: "full" | "summary") => void;
  clearRun: (runId: string) => void;
  clear: () => void;
};

/** Create the single record map used by Gateway chat-run runtime state. */
export function createChatRunState(): ChatRunState {
  const store = createChatRunRecordStore();
  const registry = createChatRunRegistryForStore(store);
  const toolEventRecipients = createToolEventRecipientRegistryForStore(store);

  const recordProgressEvent = (
    runId: string,
    event: AgentEventPayload,
    mode?: "full" | "summary",
  ) => {
    const progressSnapshot = updateChatRunProgressSnapshot(
      store.runs.get(runId)?.progressSnapshot,
      event,
      mode,
    );
    if (progressSnapshot) {
      store.getOrCreate(runId).progressSnapshot = progressSnapshot;
    }
  };

  const clearRun = (runId: string) => {
    const record = store.runs.get(runId);
    if (!record) {
      return;
    }
    delete record.rawBuffer;
    delete record.buffer;
    delete record.bufferIsCurrent;
    record.liveTextGroup?.abort();
    delete record.liveTextGroup;
    delete record.liveTextEpoch;
    delete record.display;
    delete record.planSnapshot;
    delete record.progressSnapshot;
    delete record.canvasBlocks;
    delete record.deltaSentAt;
    delete record.assistantScope;
    delete record.managedMediaUrls;
    clearPendingLiveTextFlushes(record);
    delete record.agentText;
    store.releaseIfEmpty(runId);
  };

  const clear = () => {
    for (const record of store.runs.values()) {
      clearPendingLiveTextFlushes(record);
      record.liveTextGroup?.abort();
    }
    store.runs.clear();
  };

  const updateBuffer = (runId: string, input: Parameters<typeof mergeAssistantText>[1]) => {
    const record = store.getOrCreate(runId);
    const display = record.display;
    if (input.managedMediaUrls?.length) {
      const urls = (record.managedMediaUrls ??= new Set<string>());
      const previousSize = urls.size;
      input.managedMediaUrls.forEach((url) => urls.add(url));
      if (display && urls.size !== previousSize) {
        display.reset = true;
        delete display.itemStartOffset;
      }
    }
    const snapshot = mergeAssistantText(
      { text: record.rawBuffer ?? "", scope: record.assistantScope },
      input,
      "live",
    );
    refreshLiveItemOffsetCache(display, record.assistantScope, snapshot.scope, input.replace);
    record.assistantScope = snapshot.scope;
    const text = capLiveAssistantText(snapshot, display);
    record.rawBuffer = text;
    if (display) {
      display.reset ||= text.length !== snapshot.text.length || input.replace === true;
      display.pendingRawDelta =
        snapshot.appendedText !== undefined && display.pendingRawDelta !== null
          ? (display.pendingRawDelta ?? "") + snapshot.appendedText
          : null;
    }
    return text;
  };

  const resolveBuffer = (runId: string, options?: { final?: boolean }) => {
    const record = store.runs.get(runId);
    if (!record || record.bufferIsCurrent?.() === false) {
      return projectLiveAssistantBufferedText("");
    }
    const withAssistantScope = <T extends { text: string; suppress: boolean }>(projected: T) => {
      return attachLiveAssistantItemScope(projected, {
        scope: record.assistantScope,
        managedMediaUrls: record.managedMediaUrls,
        final: options?.final,
        cache: record.display,
      });
    };
    const rawText = record.rawBuffer;
    if (rawText === undefined) {
      return withAssistantScope(projectLiveAssistantBufferedText(record.buffer ?? ""));
    }
    const createProjector = () =>
      createLiveAssistantTextProjection({
        ...options,
        managedMediaUrls: record.managedMediaUrls ? [...record.managedMediaUrls] : undefined,
      });
    // Finalization releases ambiguous tails without changing the live projection.
    if (options?.final) {
      return withAssistantScope(createProjector().replace(rawText));
    }
    let display = record.display;
    if (!display) {
      const projector = createProjector();
      display = record.display = {
        projector,
        current: projector.replace(rawText),
        unsentDelta: null,
      };
    } else if (display.reset || display.pendingRawDelta !== undefined) {
      const { projector, pendingRawDelta, reset } = display;
      if (reset) {
        display.projector = createProjector();
      }
      // Delta-only producers prove appends. Cumulative snapshots retain their
      // correction contract and need one prefix check before entering the chain.
      const delta = reset
        ? null
        : pendingRawDelta === null
          ? rawText.startsWith(projector.source)
            ? rawText.slice(projector.source.length)
            : null
          : pendingRawDelta;
      display.current =
        delta == null
          ? display.projector.replace(rawText)
          : display.projector.append(delta, rawText);
      if (display.current.delta === null) {
        delete display.itemStartOffset;
      }
      display.unsentDelta =
        display.unsentDelta !== null && display.current.delta !== null
          ? display.unsentDelta + display.current.delta
          : null;
      delete display.pendingRawDelta;
      delete display.reset;
    }
    record.buffer = display.current.text;
    return withAssistantScope(display.current);
  };

  const takeBufferDelta = (runId: string, text: string) => {
    const projected = resolveBuffer(runId);
    const record = store.getOrCreate(runId);
    const display = (record.display ??= {
      projector: createLiveAssistantTextProjection(),
      current: { ...projectLiveAssistantBufferedText(record.buffer ?? ""), delta: null },
      unsentDelta: null,
    });
    const visible = projected.suppress ? "" : projected.text;
    const previous = display.sentText;
    const append =
      text === visible && previous !== undefined && display.unsentDelta !== null
        ? display.unsentDelta
        : previous === undefined
          ? text
          : text.startsWith(previous)
            ? text.slice(previous.length)
            : null;
    display.sentText = text;
    display.unsentDelta = text === visible ? "" : null;
    return projectLiveAssistantBufferDelta(projected, append, text);
  };

  return {
    runs: store.runs,
    registry,
    toolEventRecipients,
    getOrCreate: store.getOrCreate,
    resolveBuffer,
    updateBuffer,
    takeBufferDelta,
    flushPendingText: (runId) => {
      const record = store.runs.get(runId);
      if (!record) {
        return;
      }
      const pending = Object.values(record.pendingTextFlushes ?? {});
      clearPendingLiveTextFlushes(record);
      for (const flush of pending) {
        flush.flush();
      }
    },
    hasAbortMarker: (runId) => store.runs.get(runId)?.abortMarker !== undefined,
    deleteAbortMarker: (runId) => {
      const record = store.runs.get(runId);
      if (!record) {
        return;
      }
      delete record.abortMarker;
      store.releaseIfEmpty(runId);
    },
    recordProgressEvent,
    clearRun,
    clear,
  };
}

export type ToolEventRecipientRegistry = {
  add: (runId: string, connId: string) => void;
  get: (runId: string) => ReadonlySet<string> | undefined;
  markFinal: (runId: string) => void;
  pruneExpired: (now?: number) => void;
};

export type SessionEventSubscriberRegistry = {
  subscribe: (connId: string) => void;
  unsubscribe: (connId: string) => void;
  getAll: () => ReadonlySet<string>;
};

export type SessionMessageSubscriberRegistry = {
  subscribe: (
    connId: string,
    sessionKey: string,
    opts?: {
      includeApprovals?: boolean;
      provisional?: boolean;
      mode?: "narration";
      subscriptionId?: string;
    },
  ) => SessionMessageSubscription | undefined;
  unsubscribe: (connId: string, sessionKey: string, subscriptionId?: string) => void;
  unsubscribeAll: (connId: string) => void;
  get: (sessionKey: string) => ReadonlySet<string>;
  getApprovals: (sessionKey: string) => ReadonlySet<string>;
  getNarration: (sessionKey: string) => ReadonlySet<string>;
  onChange: (listener: (sessionKey: string, connId: string) => void) => () => void;
};

type SessionMessageSubscription = (() => void) & { commit: () => void };

type SessionMessageSubscriptionMode = {
  includeApprovals: boolean;
  mode?: "narration";
};

type ProvisionalSubscriptionState = {
  committed?: { sequence: number; mode: SessionMessageSubscriptionMode };
  inflight: Map<number, SessionMessageSubscriptionMode>;
};

type SessionMessageSubscriptionOwners = Map<string | undefined, ProvisionalSubscriptionState>;

const TOOL_EVENT_RECIPIENT_TTL_MS = 10 * 60 * 1000;
const TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS = 30 * 1000;

/** Create the broad sessions.changed subscriber registry. */
export function createSessionEventSubscriberRegistry(
  isConnectionActive?: (connId: string) => boolean,
  onSubscriptionChange?: (connId: string) => void,
): SessionEventSubscriberRegistry {
  const connIds = new Set<string>();
  const empty = new Set<string>();

  return {
    subscribe: (connId: string) => {
      const normalized = connId.trim();
      if (!normalized || isConnectionActive?.(normalized) === false) {
        return;
      }
      onSubscriptionChange?.(normalized);
      connIds.add(normalized);
    },
    unsubscribe: (connId: string) => {
      const normalized = connId.trim();
      if (!normalized) {
        return;
      }
      onSubscriptionChange?.(normalized);
      connIds.delete(normalized);
    },
    getAll: () => (connIds.size > 0 ? connIds : empty),
  };
}

/** Create the per-session message subscriber registry. */
export function createSessionMessageSubscriberRegistry(
  isConnectionActive?: (connId: string) => boolean,
  onSubscriptionChange?: (connId: string) => void,
): SessionMessageSubscriberRegistry {
  const sessionToConnIds = new Map<string, Set<string>>();
  // Removing a record fences late replay settlements, including connection/session reuse.
  const connections = new Map<string, Map<string, SessionMessageSubscriptionOwners>>();
  const approvalSessionToConnIds = new Map<string, Set<string>>();
  const narrationSessionToConnIds = new Map<string, Set<string>>();
  const changeListeners = new Set<(sessionKey: string, connId: string) => void>();
  const empty = new Set<string>();
  let subscriptionSequence = 0;

  const setMembership = (
    index: Map<string, Set<string>>,
    connId: string,
    sessionKey: string,
    subscribed: boolean,
  ) => {
    const connIds = index.get(sessionKey);
    if (subscribed) {
      const nextConnIds = connIds ?? new Set<string>();
      nextConnIds.add(connId);
      index.set(sessionKey, nextConnIds);
      return;
    }
    connIds?.delete(connId);
    if (connIds?.size === 0) {
      index.delete(sessionKey);
    }
  };
  const setSubscription = (
    connId: string,
    sessionKey: string,
    mode?: SessionMessageSubscriptionMode,
  ) => {
    const subscribed = mode !== undefined;
    const narration = mode?.mode === "narration";
    const changed =
      (sessionToConnIds.get(sessionKey)?.has(connId) === true) !== subscribed ||
      (narrationSessionToConnIds.get(sessionKey)?.has(connId) === true) !== narration;
    setMembership(sessionToConnIds, connId, sessionKey, subscribed);
    setMembership(approvalSessionToConnIds, connId, sessionKey, mode?.includeApprovals === true);
    setMembership(narrationSessionToConnIds, connId, sessionKey, narration);
    if (changed) {
      for (const listener of changeListeners) {
        listener(sessionKey, connId);
      }
    }
  };
  const updateSubscription = (
    connId: string,
    sessionKey: string,
    owners?: SessionMessageSubscriptionOwners,
  ) => {
    let mode: SessionMessageSubscriptionMode | undefined;
    const include = (interest: SessionMessageSubscriptionMode) => {
      if (!mode) {
        mode = { ...interest };
      } else {
        mode.includeApprovals ||= interest.includeApprovals;
        if (interest.mode !== "narration") {
          mode.mode = undefined;
        }
      }
    };
    for (const owner of owners?.values() ?? []) {
      if (owner.committed) {
        include(owner.committed.mode);
      }
      for (const interest of owner.inflight.values()) {
        include(interest);
      }
    }
    setSubscription(connId, sessionKey, mode);
  };

  const registry: SessionMessageSubscriberRegistry = {
    subscribe: (connId: string, sessionKey: string, opts) => {
      const normalizedConnId = connId.trim();
      const normalizedSessionKey = sessionKey.trim();
      if (
        !normalizedConnId ||
        !normalizedSessionKey ||
        isConnectionActive?.(normalizedConnId) === false
      ) {
        return undefined;
      }
      onSubscriptionChange?.(normalizedConnId);
      const states =
        connections.get(normalizedConnId) ?? new Map<string, SessionMessageSubscriptionOwners>();
      const owners: SessionMessageSubscriptionOwners =
        states.get(normalizedSessionKey) ?? new Map();
      const subscriptionId = opts?.subscriptionId;
      const state: ProvisionalSubscriptionState = owners.get(subscriptionId) ?? {
        inflight: new Map(),
      };
      owners.set(subscriptionId, state);
      states.set(normalizedSessionKey, owners);
      connections.set(normalizedConnId, states);
      subscriptionSequence += 1;
      const provisionalRecency = subscriptionSequence;
      const mode: SessionMessageSubscriptionMode = {
        includeApprovals: opts?.includeApprovals === true,
        mode: opts?.mode,
      };
      state.inflight.set(provisionalRecency, mode);
      updateSubscription(normalizedConnId, normalizedSessionKey, owners);
      let settled = false;
      const settle = (succeeded: boolean) => {
        if (
          settled ||
          connections.get(normalizedConnId)?.get(normalizedSessionKey)?.get(subscriptionId) !==
            state
        ) {
          return;
        }
        settled = true;
        if (succeeded && provisionalRecency >= (state.committed?.sequence ?? -Infinity)) {
          state.committed = {
            sequence: provisionalRecency,
            mode,
          };
        }
        state.inflight.delete(provisionalRecency);
        if (!state.committed && state.inflight.size === 0) {
          onSubscriptionChange?.(normalizedConnId);
          owners.delete(subscriptionId);
        }
        if (owners.size === 0) {
          states.delete(normalizedSessionKey);
        }
        updateSubscription(normalizedConnId, normalizedSessionKey, owners);
        if (states.size === 0) {
          connections.delete(normalizedConnId);
        }
      };
      const rollback = (() => settle(false)) as SessionMessageSubscription;
      rollback.commit = () => settle(true);
      if (!opts?.provisional) {
        rollback.commit();
        return undefined;
      }
      return rollback;
    },
    unsubscribe: (connId: string, sessionKey: string, subscriptionId?: string) => {
      const normalizedConnId = connId.trim();
      const normalizedSessionKey = sessionKey.trim();
      if (!normalizedConnId || !normalizedSessionKey) {
        return;
      }
      onSubscriptionChange?.(normalizedConnId);
      const states = connections.get(normalizedConnId);
      const owners = states?.get(normalizedSessionKey);
      owners?.delete(subscriptionId);
      if (owners?.size === 0) {
        states?.delete(normalizedSessionKey);
      }
      if (states?.size === 0) {
        connections.delete(normalizedConnId);
      }
      updateSubscription(normalizedConnId, normalizedSessionKey, owners);
    },
    unsubscribeAll: (connId: string) => {
      const normalizedConnId = connId.trim();
      if (!normalizedConnId) {
        return;
      }
      onSubscriptionChange?.(normalizedConnId);
      const states = connections.get(normalizedConnId);
      if (!states) {
        return;
      }
      connections.delete(normalizedConnId);
      for (const sessionKey of states.keys()) {
        setSubscription(normalizedConnId, sessionKey);
      }
    },
    get: (sessionKey) => sessionToConnIds.get(sessionKey.trim()) ?? empty,
    getApprovals: (sessionKey) => approvalSessionToConnIds.get(sessionKey.trim()) ?? empty,
    getNarration: (sessionKey) => narrationSessionToConnIds.get(sessionKey.trim()) ?? empty,
    onChange: (listener) => {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
  };
  return registry;
}

function createToolEventRecipientRegistryForStore(
  store: ChatRunRecordStore,
): ToolEventRecipientRegistry {
  let nextPruneAt = Infinity;
  const pruneExpired = (now = Date.now()) => {
    if (now < nextPruneAt) {
      return;
    }
    nextPruneAt = Infinity;
    for (const [runId, record] of store.runs) {
      const entry = record.toolRecipient;
      if (!entry) {
        continue;
      }
      const cutoff = entry.finalizedAt
        ? entry.finalizedAt + TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS
        : entry.updatedAt + TOOL_EVENT_RECIPIENT_TTL_MS;
      if (now >= cutoff) {
        delete record.toolRecipient;
        store.releaseIfEmpty(runId);
      } else {
        nextPruneAt = Math.min(nextPruneAt, cutoff);
      }
    }
  };

  const prune = (updated: ChatRunToolRecipientState) => {
    // Refreshes can move expiry later; a conservative lower bound avoids a
    // full run scan on each tool event while retaining exact expiry cleanup.
    nextPruneAt = Math.min(
      nextPruneAt,
      updated.finalizedAt
        ? updated.finalizedAt + TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS
        : updated.updatedAt + TOOL_EVENT_RECIPIENT_TTL_MS,
    );
    pruneExpired();
  };

  const add = (runId: string, connId: string) => {
    if (!runId || !connId) {
      return;
    }
    const now = Date.now();
    const entry = (store.getOrCreate(runId).toolRecipient ??= {
      connIds: new Set<string>(),
      updatedAt: now,
    });
    entry.connIds.add(connId);
    entry.updatedAt = now;
    prune(entry);
  };

  const get = (runId: string) => {
    const entry = store.runs.get(runId)?.toolRecipient;
    if (entry) {
      entry.updatedAt = Date.now();
      prune(entry);
    }
    // Pruning may retire this finalized run; never return its former audience.
    return store.runs.get(runId)?.toolRecipient?.connIds;
  };

  const markFinal = (runId: string) => {
    const entry = store.runs.get(runId)?.toolRecipient;
    if (!entry) {
      return;
    }
    entry.finalizedAt = Date.now();
    prune(entry);
  };

  return { add, get, markFinal, pruneExpired };
}
