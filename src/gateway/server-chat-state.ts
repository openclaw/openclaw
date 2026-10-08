import type { AgentPlanStep } from "../channels/streaming.js";
import type { AgentEventPayload, AgentAssistantSourceReceipt } from "../infra/agent-events.js";
import type { ChatCanvasBlock } from "./chat-display-projection.canvas.js";
import {
  createLiveAssistantTextProjection,
  projectLiveAssistantBufferedText,
} from "./live-chat-projector.js";
import * as assistantText from "./server-chat-buffer.js";
import type { ChatRunProgressSnapshot } from "./server-chat-progress-snapshot.js";
import { updateChatRunProgressSnapshot } from "./server-chat-progress-snapshot.js";
import {
  createToolEventRecipientRegistry,
  type ChatRunToolRecipientState,
} from "./server-chat-tool-recipients.js";

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

/** Create an abort marker ordered against chat run registrations, using a shared monotonic sequence. */
export function createChatAbortMarker(now = Date.now()): ChatAbortMarker {
  return { abortedAtMs: now, sequence: ++chatRunOrderingSequence };
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

type PendingLiveTextFlush = {
  timer: NodeJS.Timeout;
  flush: () => void;
};

export type ChatRunRecord = assistantText.ChatRunBufferState & {
  lastActivityAt: number;
  registrations?: ChatRunEntry[];
  bufferIsCurrent?: () => boolean;
  /** Retire queued connection snapshots when this buffering generation is cleared. */
  liveTextGroup?: AbortController;
  liveTextEpoch?: object;
  planSnapshot?: ChatRunPlanSnapshot;
  progressSnapshot?: ChatRunProgressSnapshot;
  canvasBlocks?: ChatCanvasBlock[];
  deltaSentAt?: number;
  agentText?: Partial<
    Record<"assistant" | "thinking" | "preamble" | "answer_candidate", ChatRunAgentTextState>
  >;
  abortMarker?: ChatAbortMarker;
  toolRecipient?: ChatRunToolRecipientState;
  /** Fixed-deadline trailing wake-up owned by this run's buffered state. */
  pendingTextFlushes?: Partial<Record<"chat" | "agent", PendingLiveTextFlush>>;
  bufferPublication?: {
    pending: number;
    isCurrent: () => boolean;
    terminal?: () => void;
    snapshot?: assistantText.ChatRunBufferState;
  };
};

type ChatRunRecordStore = ReturnType<typeof createChatRunRecordStore>;

function createChatRunRecordStore() {
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

type ChatRunRegistry = {
  add: (sessionId: string, entry: ChatRunRegistration) => void;
  peek: (sessionId: string) => ChatRunEntry | undefined;
  shift: (sessionId: string) => ChatRunEntry | undefined;
  remove: (sessionId: string, clientRunId: string, sessionKey?: string) => ChatRunEntry | undefined;
};

function createChatRunRegistryForStore(store: ChatRunRecordStore): ChatRunRegistry {
  const add = (sessionId: string, entry: ChatRunRegistration) => {
    const registeredEntry = { ...entry, registeredSequence: ++chatRunOrderingSequence };
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

export type ChatRunState = ReturnType<typeof createChatRunState>;

/** Create the single record map used by Gateway chat-run runtime state. */
export function createChatRunState(isConnectionActive?: (connId: string) => boolean) {
  const store = createChatRunRecordStore();
  const registry = createChatRunRegistryForStore(store);
  const toolEventRecipients = createToolEventRecipientRegistry(store, isConnectionActive);

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

  const clearRun = (runId: string, preservePublication = false) => {
    const record = store.runs.get(runId);
    if (!record) {
      return;
    }
    delete record.rawBuffer;
    delete record.rawOffset;
    delete record.assistantItems;
    if (!preservePublication && record.bufferPublication) {
      delete record.bufferPublication.terminal;
      delete record.bufferPublication;
    }
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
    delete record.assistantScopeOffset;
    delete record.assistantOccurrenceId;
    delete record.managedMediaUrls;
    clearPendingLiveTextFlushes(record);
    delete record.agentText;
    store.releaseIfEmpty(runId);
  };

  const resolveBufferPublication = (record: ChatRunRecord) => {
    const pending = record.bufferPublication;
    if (pending && !pending.isCurrent()) {
      delete pending.terminal;
      delete record.bufferPublication;
      return undefined;
    }
    return pending;
  };

  const clear = () => {
    for (const runId of store.runs.keys()) {
      clearRun(runId);
    }
    store.runs.clear();
  };

  const resolveBuffer = (
    runId: string,
    options?: Parameters<typeof assistantText.projectBuffer>[1],
  ): ReturnType<typeof assistantText.projectBuffer> => {
    const record = store.runs.get(runId);
    return !record || record.bufferIsCurrent?.() === false
      ? projectLiveAssistantBufferedText("")
      : assistantText.projectBuffer(record, options);
  };

  const takeBufferDelta = (runId: string, text: string) => {
    const projected = resolveBuffer(runId, { publishedOnly: true });
    const record = store.getOrCreate(runId);
    const display = (record.display ??= {
      projector: createLiveAssistantTextProjection(),
      current: { ...projectLiveAssistantBufferedText(record.buffer ?? ""), delta: null },
      unsentDelta: null,
    });
    const visible = projected.suppress ? "" : projected.text;
    const previous = display.sentText;
    const append =
      previous === undefined
        ? text
        : display.unsentDelta === null
          ? null
          : text === visible
            ? display.unsentDelta
            : text.startsWith(previous)
              ? text.slice(previous.length)
              : null;
    display.sentText = text;
    display.unsentDelta = visible.startsWith(text) ? visible.slice(text.length) : null;
    return append === null && (text !== "" || previous !== "")
      ? { deltaText: text, replace: true as const }
      : append
        ? { deltaText: append }
        : undefined;
  };

  return {
    runs: store.runs,
    registry,
    toolEventRecipients,
    /** Acquire mutable state and record activity; readers use runs.get. */
    getOrCreate: store.getOrCreate,
    resolveBuffer,
    updateBuffer: (
      runId: string,
      input: Parameters<typeof assistantText.updateBuffer>[1],
      source?: AgentAssistantSourceReceipt,
    ) => assistantText.updateBuffer(store.getOrCreate(runId), input, source),
    retireBuffer: (runId: string, itemIds: readonly string[], published = false) =>
      assistantText.retireBuffer(store.getOrCreate(runId), itemIds, published),
    retireSource: (runId: string, source: AgentAssistantSourceReceipt) =>
      assistantText.retireSource(store.runs.get(runId), source),
    prepareBufferPublication: (
      runId: string,
      sourceRunId: string,
      source: AgentAssistantSourceReceipt | undefined,
      itemIds: readonly string[],
      isCurrent: () => boolean,
      onPublished: () => void,
    ): { published: () => void; settled: () => void } | undefined => {
      const record = store.getOrCreate(runId);
      const link = registry.peek(sourceRunId);
      if (
        record.bufferIsCurrent?.() === false ||
        isChatAbortMarkerCurrent(record.abortMarker, link)
      ) {
        return undefined;
      }
      const pending = resolveBufferPublication(record);
      const buffer = record.assistantItems ? record : (pending?.snapshot ?? record);
      if (source) {
        assistantText.retireSource(buffer, source);
      } else {
        assistantText.retireBuffer(buffer, itemIds);
      }
      const items = buffer.assistantItems;
      if (!items) {
        return undefined;
      }
      const batch = (record.bufferPublication ??= { pending: 0, isCurrent });
      batch.pending += 1;
      const publishedIds = source?.itemId ? [source.itemId] : itemIds;
      const publish = () => {
        // Accepted terminals retain this occurrence map after their live state clears.
        if (
          !assistantText.retireBuffer({ assistantItems: items }, publishedIds, true) ||
          store.runs.get(runId) !== record ||
          record.assistantItems !== items ||
          record.bufferIsCurrent?.() === false ||
          registry.peek(sourceRunId) !== link ||
          isChatAbortMarkerCurrent(record.abortMarker, link)
        ) {
          return;
        }
        if (record.display) {
          record.display.reset = true;
        }
        record.liveTextEpoch = {};
        onPublished();
      };
      let didSettle = false;
      const settled = () => {
        if (didSettle) {
          return;
        }
        didSettle = true;
        if (--batch.pending > 0) {
          return;
        }
        const terminal = batch.terminal;
        delete batch.terminal;
        try {
          terminal?.();
        } finally {
          if (record.bufferPublication === batch) {
            delete record.bufferPublication;
          }
          store.releaseIfEmpty(runId);
        }
      };
      return {
        published: () => {
          publish();
          settled();
        },
        settled,
      };
    },
    afterBufferPublication: (
      runId: string,
      sourceRunId: string,
      send: (projection: ReturnType<typeof assistantText.projectBuffer>) => void,
    ): boolean => {
      const record = store.runs.get(runId);
      const batch = record && resolveBufferPublication(record);
      if (!record || !batch) {
        return false;
      }
      const snapshot = (batch.snapshot = { ...record });
      const registrations = new Set(store.runs.get(sourceRunId)?.registrations);
      const ownerIsCurrent = batch.isCurrent;
      batch.isCurrent = () =>
        ownerIsCurrent() &&
        !store.runs.get(sourceRunId)?.registrations?.some((entry) => !registrations.has(entry));
      // The accepted terminal survives its own cleanup, never a successor stream.
      batch.terminal = () => {
        const current = store.runs.get(runId);
        if (
          current === record &&
          current.bufferPublication === batch &&
          batch.isCurrent() &&
          !current.assistantItems &&
          !current.liveTextEpoch
        ) {
          send(assistantText.projectBuffer(snapshot, { final: true, publishedOnly: true }));
        }
      };
      return true;
    },
    takeBufferDelta,
    flushPendingText: (runId: string) => {
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
    hasAbortMarker: (runId: string) => store.runs.get(runId)?.abortMarker !== undefined,
    deleteAbortMarker: (runId: string) => {
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
      const settle = (succeeded: boolean) => {
        if (
          !state.inflight.has(provisionalRecency) ||
          connections.get(normalizedConnId)?.get(normalizedSessionKey)?.get(subscriptionId) !==
            state
        ) {
          return;
        }
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
