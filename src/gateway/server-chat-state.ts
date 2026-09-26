import type { AgentPlanStep } from "../channels/streaming.js";
// Gateway chat run state registries.
// Tracks active runs, delta buffers, tool recipients, and session subscribers.
import type { AgentEventPayload } from "../infra/agent-events.js";
import { mergeAssistantText, type AssistantTextSnapshot } from "./agent-event-assistant-text.js";
import type { ChatCanvasBlock } from "./chat-display-projection.canvas.js";
import {
  capLiveAssistantText,
  createLiveAssistantTextProjection,
  projectLiveAssistantBufferedText,
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

type LiveDisplayState = {
  projector: ReturnType<typeof createLiveAssistantTextProjection>;
  current: ReturnType<ReturnType<typeof createLiveAssistantTextProjection>["replace"]>;
  pendingRawDelta?: string | null;
  reset?: boolean;
  unsentDelta: string | null;
  sentText?: string;
};

type ChatRunRecord = {
  lastActivityAt: number;
  registrations?: ChatRunEntry[];
  rawBuffer?: string;
  buffer?: string;
  bufferIsCurrent?: () => boolean;
  /** Retire queued connection snapshots when this buffering generation is cleared. */
  liveTextGroup?: AbortController;
  display?: LiveDisplayState;
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
  resolveBuffer: (
    runId: string,
    options?: { final?: boolean },
  ) => { text: string; suppress: boolean };
  updateBuffer: (runId: string, input: Parameters<typeof mergeAssistantText>[1]) => string;
  takeBufferDelta: (
    runId: string,
    text: string,
  ) => { deltaText: string; replace?: true } | undefined;
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
      }
    }
    const snapshot = mergeAssistantText(
      { text: record.rawBuffer ?? "", scope: record.assistantScope },
      input,
      "live",
    );
    record.assistantScope = snapshot.scope;
    const text = capLiveAssistantText(snapshot);
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
    const rawText = record.rawBuffer;
    if (rawText === undefined) {
      return projectLiveAssistantBufferedText(record.buffer ?? "");
    }
    const createProjector = () =>
      createLiveAssistantTextProjection({
        ...options,
        managedMediaUrls: record.managedMediaUrls ? [...record.managedMediaUrls] : undefined,
      });
    // Finalization releases ambiguous tails without changing the live projection.
    if (options?.final) {
      return createProjector().replace(rawText);
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
      display.unsentDelta =
        display.unsentDelta !== null && display.current.delta !== null
          ? display.unsentDelta + display.current.delta
          : null;
      delete display.pendingRawDelta;
      delete display.reset;
    }
    record.buffer = display.current.text;
    return display.current;
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
    return append === null
      ? { deltaText: text, replace: true as const }
      : append
        ? { deltaText: append }
        : undefined;
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
    opts?: { includeApprovals?: boolean; provisional?: boolean },
  ) => SessionMessageSubscription | undefined;
  unsubscribe: (connId: string, sessionKey: string) => void;
  unsubscribeAll: (connId: string) => void;
  get: (sessionKey: string) => ReadonlySet<string>;
  getApprovals: (sessionKey: string) => ReadonlySet<string>;
  onChange: (listener: (sessionKey: string) => void) => () => void;
};

type SessionMessageSubscription = (() => void) & { commit: () => void };

type ProvisionalSubscriptionState = {
  base?: boolean;
  inflight: number;
  lastSuccess?: { sequence: number; includeApprovals: boolean };
};

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
  // Booleans retain committed approval mode; records own unsettled replays.
  // Replacing a record fences late settlements, including connection/session reuse.
  const connections = new Map<string, Map<string, boolean | ProvisionalSubscriptionState>>();
  const approvalSessionToConnIds = new Map<string, Set<string>>();
  const changeListeners = new Set<(sessionKey: string) => void>();
  const empty = new Set<string>();
  let subscriptionSequence = 0;

  const setMessageSubscription = (connId: string, sessionKey: string, subscribed: boolean) => {
    const connIds = sessionToConnIds.get(sessionKey);
    const wasSubscribed = connIds?.has(connId) === true;
    if (subscribed) {
      const nextConnIds = connIds ?? new Set<string>();
      nextConnIds.add(connId);
      sessionToConnIds.set(sessionKey, nextConnIds);
      if (!wasSubscribed) {
        for (const listener of changeListeners) {
          listener(sessionKey);
        }
      }
      return;
    }
    connIds?.delete(connId);
    if (connIds?.size === 0) {
      sessionToConnIds.delete(sessionKey);
    }
    if (wasSubscribed) {
      for (const listener of changeListeners) {
        listener(sessionKey);
      }
    }
  };
  const setApprovalSubscription = (connId: string, sessionKey: string, subscribed: boolean) => {
    const connIds = approvalSessionToConnIds.get(sessionKey);
    if (subscribed) {
      const nextConnIds = connIds ?? new Set<string>();
      nextConnIds.add(connId);
      approvalSessionToConnIds.set(sessionKey, nextConnIds);
      return;
    }
    connIds?.delete(connId);
    if (connIds?.size === 0) {
      approvalSessionToConnIds.delete(sessionKey);
    }
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
        connections.get(normalizedConnId) ??
        new Map<string, boolean | ProvisionalSubscriptionState>();
      const previous = states.get(normalizedSessionKey);
      const state: ProvisionalSubscriptionState =
        typeof previous === "object" ? previous : { base: previous, inflight: 0 };
      state.inflight += 1;
      states.set(normalizedSessionKey, state);
      connections.set(normalizedConnId, states);
      subscriptionSequence += 1;
      const provisionalRecency = subscriptionSequence;
      setMessageSubscription(normalizedConnId, normalizedSessionKey, true);

      setApprovalSubscription(
        normalizedConnId,
        normalizedSessionKey,
        opts?.includeApprovals === true,
      );
      let settled = false;
      const settle = (succeeded: boolean) => {
        if (settled || connections.get(normalizedConnId)?.get(normalizedSessionKey) !== state) {
          return;
        }
        settled = true;
        if (succeeded) {
          if (provisionalRecency >= (state.lastSuccess?.sequence ?? -Infinity)) {
            state.lastSuccess = {
              sequence: provisionalRecency,
              includeApprovals: opts?.includeApprovals === true,
            };
          }
        }
        state.inflight -= 1;
        if (state.inflight > 0) {
          return;
        }
        const committed = state.lastSuccess?.includeApprovals ?? state.base;
        if (committed === undefined) {
          onSubscriptionChange?.(normalizedConnId);
          states.delete(normalizedSessionKey);
          setMessageSubscription(normalizedConnId, normalizedSessionKey, false);
          setApprovalSubscription(normalizedConnId, normalizedSessionKey, false);
        } else {
          states.set(normalizedSessionKey, committed);
          setMessageSubscription(normalizedConnId, normalizedSessionKey, true);
          setApprovalSubscription(normalizedConnId, normalizedSessionKey, committed);
        }
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
    unsubscribe: (connId: string, sessionKey: string) => {
      const normalizedConnId = connId.trim();
      const normalizedSessionKey = sessionKey.trim();
      if (!normalizedConnId || !normalizedSessionKey) {
        return;
      }
      onSubscriptionChange?.(normalizedConnId);
      const states = connections.get(normalizedConnId);
      states?.delete(normalizedSessionKey);
      if (states?.size === 0) {
        connections.delete(normalizedConnId);
      }
      setMessageSubscription(normalizedConnId, normalizedSessionKey, false);
      setApprovalSubscription(normalizedConnId, normalizedSessionKey, false);
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
        setMessageSubscription(normalizedConnId, sessionKey, false);
      }
      for (const sessionKey of states.keys()) {
        setApprovalSubscription(normalizedConnId, sessionKey, false);
      }
    },
    get: (sessionKey) => sessionToConnIds.get(sessionKey.trim()) ?? empty,
    getApprovals: (sessionKey) => approvalSessionToConnIds.get(sessionKey.trim()) ?? empty,
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
