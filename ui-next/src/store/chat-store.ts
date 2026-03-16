import { create } from "zustand";
import { generateUUID } from "@/lib/uuid";

export type ChatMessageContent = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

export type MessageUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
};

export type ChatMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string | ChatMessageContent[];
  timestamp?: number;
  runId?: string;
  // Server fields (from session transcript)
  errorMessage?: string;
  stopReason?: string;
  /** Per-turn token usage from the LLM API call. */
  usage?: MessageUsage;
  /** Metadata marker injected by the gateway (e.g. compaction dividers). */
  __openclaw?: { kind?: string; id?: string; [key: string]: unknown };
  // UI-only fields
  id: string;
  /** 1-based sequential position in the session history (stable across reloads). */
  seq: number;
  isStreaming?: boolean;
};

/** Ensure a message has a stable ID and seq; assigns defaults if missing. */
function ensureId(
  msg: Omit<ChatMessage, "id" | "seq"> & { id?: string; seq?: number },
): ChatMessage {
  return { ...msg, id: msg.id || generateUUID(), seq: msg.seq ?? 0 };
}

export type SessionEntry = {
  key: string;
  sessionId?: string;
  label?: string;
  agentId?: string;
  model?: string;
  origin?: string;
  lastActiveMs?: number;
  derivedTitle?: string;
  lastMessage?: string;
  tokenCounts?: {
    totalInput?: number;
    totalOutput?: number;
  };
  [key: string]: unknown;
};

export type QueuedMessage = {
  id: string;
  content: string | ChatMessageContent[];
  status: "pending" | "sending";
  addedAt: number;
};

export type DraftAttachment = {
  id: string;
  preview: string; // data URL
  fileName: string;
  fileType: string;
  fileSize: number;
};

export type SessionDraft = {
  inputValue: string;
  attachments: DraftAttachment[];
};

// ─── Per-session volatile state ───────────────────────────────────────────────

/**
 * All volatile state scoped to a single chat session. Each session in
 * `sessionStates` gets its own isolated bubble so parallel conversations
 * never contaminate each other's messages or stream.
 */
export type PerSessionState = {
  messages: ChatMessage[];
  messagesLoading: boolean;
  isStreaming: boolean;
  streamRunId: string | null;
  streamContent: string;
  /** Timestamp (ms) of last stream event — used to detect stuck streams */
  lastStreamEventAt: number;
  /** True when polling detected new messages (agent working in background) */
  isAgentActive: boolean;
  // Pause-display: UI pauses rendering deltas while backend continues
  isPaused: boolean;
  /** Content buffered while paused (flushed on resume) */
  pauseBuffer: string;
  // Send-pending state (typing indicator before server acks)
  isSendPending: boolean;
  /** Live activity label from gateway tool-start events (e.g. "exec: ls -la") */
  activityLabel: string;
  /** Image blocks from optimistic user messages, keyed by timestamp.
   *  Preserved across history polls so image previews survive server-side
   *  transcript round-trips (which may strip inline image data). */
  sentImageBlocks: Map<number, ChatMessageContent[]>;
};

const DEFAULT_SESSION_STATE: PerSessionState = {
  messages: [],
  messagesLoading: false,
  isStreaming: false,
  streamRunId: null,
  streamContent: "",
  lastStreamEventAt: 0,
  isAgentActive: false,
  isPaused: false,
  pauseBuffer: "",
  isSendPending: false,
  activityLabel: "",
  sentImageBlocks: new Map(),
};

/**
 * Normalize a session key for consistent Map lookups.
 * Exported so use-gateway.ts and callers use the same normalization.
 */
export function normalizeSessionKey(key: string): string {
  return key.trim();
}

/** Clone the sessionStates Map and apply an updater to one entry. */
function updateSessionEntry(
  states: Map<string, PerSessionState>,
  key: string,
  updater: (entry: PerSessionState) => PerSessionState,
): Map<string, PerSessionState> {
  const k = normalizeSessionKey(key);
  const entry = states.get(k) ?? { ...DEFAULT_SESSION_STATE, sentImageBlocks: new Map() };
  const next = new Map(states);
  next.set(k, updater(entry));
  return next;
}

// ─── Store shape ──────────────────────────────────────────────────────────────

export type ChatState = {
  // Session management
  activeSessionKey: string;
  sessions: SessionEntry[];
  sessionsLoading: boolean;

  // Per-session state map (messages, streaming, sendPending, etc.)
  sessionStates: Map<string, PerSessionState>;

  // Message queue (batch execution) — global, not per-session
  messageQueue: QueuedMessage[];
  isQueueRunning: boolean;

  // Thinking level from history
  thinkingLevel: string;

  // Pending model for the next new session (set via model picker before first send)
  pendingModelId: string | null;

  // Per-session drafts (input text + attachments preserved across navigation)
  drafts: Record<string, SessionDraft>;

  // ─── Selectors ───
  /** Read volatile state for a specific session key (returns defaults if missing). */
  getSessionState: (key: string) => PerSessionState;
  /** Shorthand for getSessionState(activeSessionKey). */
  getActiveSessionState: () => PerSessionState;

  // ─── Session management actions ───
  setActiveSessionKey: (key: string) => void;
  setSessions: (sessions: SessionEntry[]) => void;
  setSessionsLoading: (loading: boolean) => void;

  // ─── Per-session message actions (all require explicit sessionKey) ───
  setMessages: (
    messages: Array<Omit<ChatMessage, "id"> & { id?: string }>,
    isRunning: boolean | undefined,
    sessionKey: string,
  ) => void;
  setMessagesLoading: (loading: boolean, sessionKey: string) => void;
  appendMessage: (message: Omit<ChatMessage, "id"> & { id?: string }, sessionKey: string) => void;
  /** Remove messages from index onwards (used by regenerate to drop the last exchange).
   *  Applies to the currently active session. */
  truncateMessagesFrom: (index: number) => void;

  // ─── Send-pending actions ───
  setSendPending: (pending: boolean, sessionKey: string) => void;

  // ─── Activity label ───
  setActivityLabel: (label: string, sessionKey: string) => void;

  // ─── Streaming actions (all require explicit sessionKey) ───
  startStream: (runId: string, sessionKey: string) => void;
  updateStreamDelta: (runId: string, text: string, sessionKey: string) => void;
  finalizeStream: (runId: string, sessionKey: string, text?: string, usage?: MessageUsage) => void;
  streamError: (runId: string, sessionKey: string, errorMessage?: string) => void;

  // ─── Pause-display actions (apply to active session) ───
  pauseStream: () => void;
  resumeStream: () => void;

  // ─── Queue actions ───
  enqueueMessage: (content: string | ChatMessageContent[]) => void;
  removeFromQueue: (id: string) => void;
  reorderQueue: (fromIndex: number, toIndex: number) => void;
  clearQueue: () => void;
  setQueueRunning: (running: boolean) => void;
  /** Shift the first pending item to 'sending' and return it, or null if empty. */
  dequeueNext: () => QueuedMessage | null;

  setThinkingLevel: (level: string) => void;
  setPendingModelId: (modelId: string | null) => void;

  // ─── Draft actions ───
  getDraft: (sessionKey: string) => SessionDraft;
  setDraftInput: (sessionKey: string, value: string) => void;
  setDraftAttachments: (sessionKey: string, attachments: DraftAttachment[]) => void;
  clearDraft: (sessionKey: string) => void;

  reset: () => void;
};

/**
 * Strip the vision-fallback prefix that gets injected when the primary model
 * doesn't support inline images (e.g. `[Attached image — analyzed by glm-4.6v]...[End of image analysis]`).
 * This is an internal implementation detail that shouldn't be visible to the user.
 */
const VISION_PREFIX_RE =
  /\[Attached\s+images?\s*—\s*analyzed\s+by\s+[^\]]+\][\s\S]*?\[End of image analysis\]\s*/gi;

function stripVisionPrefix(text: string): string {
  return text.replace(VISION_PREFIX_RE, "").trimStart();
}

/**
 * Strip the /plan command instruction template, showing only the user's task.
 * The expanded template starts with "Before executing, first create..." and ends with "Task: <actual task>".
 */
const PLAN_INSTRUCTION_RE = /^Before executing, first create a step-by-step plan[\s\S]*?Task:\s*/i;

function stripPlanInstruction(text: string): string {
  return text.replace(PLAN_INSTRUCTION_RE, "/plan ").trimEnd();
}

/** Extract plain text from message content (string or content array). */
export function getMessageText(msg: ChatMessage): string {
  if (typeof msg.content === "string") {
    return msg.role === "user" ? stripPlanInstruction(stripVisionPrefix(msg.content)) : msg.content;
  }
  const parts = msg.content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("");
  return msg.role === "user" ? stripPlanInstruction(stripVisionPrefix(parts)) : parts;
}

/** Extract image URLs from structured content blocks. */
export function getMessageImages(msg: ChatMessage): Array<{ url: string; alt?: string }> {
  if (typeof msg.content === "string") {
    return [];
  }
  const images: Array<{ url: string; alt?: string }> = [];
  for (const block of msg.content) {
    if (block.type === "image") {
      // Anthropic-style: { type: "image", source: { type, media_type, data | url } }
      const source = block.source as
        | { type?: string; media_type?: string; data?: string; url?: string }
        | undefined;
      if (source?.url) {
        images.push({ url: source.url });
      } else if (source?.data && source?.media_type) {
        images.push({ url: `data:${source.media_type};base64,${source.data}` });
      }
    } else if (block.type === "image_url") {
      // OpenAI-style: { type: "image_url", image_url: { url, detail? } }
      const imageUrl = block.image_url as { url?: string } | undefined;
      if (imageUrl?.url) {
        images.push({ url: imageUrl.url });
      }
    }
  }
  return images;
}

const emptyDraft: SessionDraft = { inputValue: "", attachments: [] };

// ─── Queue persistence (survives page refresh) ──────────────────────────────
const QUEUE_STORAGE_KEY = "operator1:messageQueue";

function loadPersistedQueue(): { messageQueue: QueuedMessage[]; isQueueRunning: boolean } {
  try {
    const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
    if (!raw) {
      return { messageQueue: [], isQueueRunning: false };
    }
    const parsed = JSON.parse(raw) as { messageQueue?: QueuedMessage[]; isQueueRunning?: boolean };
    const queue = (parsed.messageQueue ?? []).map((m) => ({
      ...m,
      // Reset any "sending" items back to "pending" (the send was interrupted by refresh)
      status: "pending" as const,
    }));
    return {
      messageQueue: queue,
      isQueueRunning: queue.length > 0 && (parsed.isQueueRunning ?? false),
    };
  } catch {
    return { messageQueue: [], isQueueRunning: false };
  }
}

function persistQueue(queue: QueuedMessage[], isQueueRunning: boolean) {
  try {
    if (queue.length === 0) {
      localStorage.removeItem(QUEUE_STORAGE_KEY);
    } else {
      localStorage.setItem(
        QUEUE_STORAGE_KEY,
        JSON.stringify({ messageQueue: queue, isQueueRunning }),
      );
    }
  } catch {
    // storage full or unavailable — ignore
  }
}

const restoredQueue = loadPersistedQueue();

const ACTIVE_SESSION_KEY = "operator1:activeSessionKey";
function loadPersistedSessionKey(): string {
  try {
    return localStorage.getItem(ACTIVE_SESSION_KEY) || "main";
  } catch {
    return "main";
  }
}

const initialState = {
  activeSessionKey: loadPersistedSessionKey(),
  sessions: [] as SessionEntry[],
  sessionsLoading: false,
  sessionStates: new Map<string, PerSessionState>(),
  messageQueue: restoredQueue.messageQueue,
  isQueueRunning: restoredQueue.isQueueRunning,
  thinkingLevel: "off",
  pendingModelId: null as string | null,
  drafts: {} as Record<string, SessionDraft>,
};

export const useChatStore = create<ChatState>((set, get) => ({
  ...initialState,

  // ─── Selectors ───

  getSessionState: (key) => {
    const k = normalizeSessionKey(key);
    return get().sessionStates.get(k) ?? DEFAULT_SESSION_STATE;
  },

  getActiveSessionState: () => {
    const k = normalizeSessionKey(get().activeSessionKey);
    return get().sessionStates.get(k) ?? DEFAULT_SESSION_STATE;
  },

  // ─── Session management ───

  setActiveSessionKey: (key) => set({ activeSessionKey: normalizeSessionKey(key) }),

  setSessions: (sessions) => set({ sessions }),
  setSessionsLoading: (loading) => set({ sessionsLoading: loading }),

  // ─── Per-session message actions ───

  setMessages: (messages, isRunning, sessionKey) => {
    const k = normalizeSessionKey(sessionKey);

    // Deduplicate: remove consecutive assistant messages with identical text
    // content (can occur when the transcript is written twice due to race conditions).
    const deduped: typeof messages = [];
    for (const m of messages) {
      if (m.role === "assistant" && deduped.length > 0) {
        const prev = deduped[deduped.length - 1];
        if (prev.role === "assistant") {
          const prevText =
            typeof prev.content === "string"
              ? prev.content
              : (prev.content ?? [])
                  .filter((c) => c.type === "text")
                  .map((c) => c.text ?? "")
                  .join("");
          const curText =
            typeof m.content === "string"
              ? m.content
              : (m.content ?? [])
                  .filter((c) => c.type === "text")
                  .map((c) => c.text ?? "")
                  .join("");
          if (prevText === curText && prevText.length > 0) {
            continue; // skip duplicate
          }
        }
      }
      deduped.push(m);
    }
    const next = deduped.map((m, i) => ensureId({ ...m, seq: i + 1 }));

    // Restore image blocks for user messages that lost them during server round-trip.
    // The server transcript may not include inline image data (e.g. when vision fallback
    // described the images as text), but we saved the originals in sentImageBlocks.
    const sessionEntry = get().sessionStates.get(k) ?? {
      ...DEFAULT_SESSION_STATE,
      sentImageBlocks: new Map(),
    };
    const imageMap = sessionEntry.sentImageBlocks;
    if (imageMap.size > 0) {
      // Collect user messages without images from the server, find nearest timestamp match.
      // The vision model call can take 10-30s, so the server timestamp may lag behind
      // the optimistic one significantly. We match each saved image set to the closest
      // user message that doesn't already have images.
      const usedTs = new Set<number>();
      for (let i = 0; i < next.length; i++) {
        const m = next[i];
        if (m.role !== "user" || !m.timestamp) {
          continue;
        }
        const hasImages =
          Array.isArray(m.content) &&
          m.content.some((c) => c.type === "image" || c.type === "image_url");
        if (hasImages) {
          continue;
        }
        // Find nearest saved image set within 60s window
        let bestTs: number | null = null;
        let bestDiff = Infinity;
        for (const [ts] of imageMap) {
          if (usedTs.has(ts)) {
            continue;
          }
          const diff = Math.abs(ts - m.timestamp);
          if (diff < 60_000 && diff < bestDiff) {
            bestDiff = diff;
            bestTs = ts;
          }
        }
        if (bestTs !== null) {
          const savedImages = imageMap.get(bestTs)!;
          usedTs.add(bestTs);
          if (typeof m.content === "string") {
            next[i] = {
              ...m,
              content: [{ type: "text", text: m.content }, ...savedImages],
            };
          } else {
            next[i] = {
              ...m,
              content: [...(m.content ?? []), ...savedImages],
            };
          }
        }
      }
    }

    // Skip update if messages are unchanged AND run state hasn't changed
    // (avoids flicker during live-polling).
    const prevEntry = get().sessionStates.get(k);
    const prev = prevEntry?.messages ?? [];
    const prevAgentActive = prevEntry?.isAgentActive ?? false;
    const agentActive = isRunning === true;
    if (prev.length === next.length && prev.length > 0 && prevAgentActive === agentActive) {
      const pLast = prev[prev.length - 1];
      const nLast = next[next.length - 1];
      if (
        pLast.role === nLast.role &&
        getMessageText(pLast) === getMessageText(nLast) &&
        pLast.timestamp === nLast.timestamp
      ) {
        return;
      }
    }

    set((state) => ({
      sessionStates: updateSessionEntry(state.sessionStates, k, (entry) => {
        // When the server says the run is done (isRunning=false) but the UI still
        // thinks it's streaming, clear the stale stream state immediately instead
        // of waiting for the 60s watchdog. This happens when the "final" WebSocket
        // event was missed (e.g. session key mismatch).
        const serverSaysDone = isRunning === false && (entry.isStreaming || entry.isSendPending);
        return {
          ...entry,
          messages: next,
          isSendPending: serverSaysDone ? false : entry.isSendPending,
          isStreaming: serverSaysDone ? false : entry.isStreaming,
          streamRunId: serverSaysDone ? null : entry.streamRunId,
          streamContent: serverSaysDone ? "" : entry.streamContent,
          isPaused: serverSaysDone ? false : entry.isPaused,
          pauseBuffer: serverSaysDone ? "" : entry.pauseBuffer,
          activityLabel: serverSaysDone ? "" : entry.activityLabel,
          // Use server-authoritative isRunning flag for agent activity detection.
          // This is reliable even when the agent is doing tool calls with no text deltas.
          isAgentActive: isRunning === true,
        };
      }),
    }));
  },

  setMessagesLoading: (loading, sessionKey) =>
    set((state) => ({
      sessionStates: updateSessionEntry(state.sessionStates, sessionKey, (entry) => ({
        ...entry,
        messagesLoading: loading,
      })),
    })),

  appendMessage: (message, sessionKey) =>
    set((state) => {
      const k = normalizeSessionKey(sessionKey);
      const entry = state.sessionStates.get(k) ?? {
        ...DEFAULT_SESSION_STATE,
        sentImageBlocks: new Map(),
      };
      // When a user message has image content blocks, save them so they survive
      // history polls (the server transcript may not include inline image data).
      let newSentImageBlocks = entry.sentImageBlocks;
      if (message.role === "user" && Array.isArray(message.content) && message.timestamp) {
        const imageBlocks = message.content.filter(
          (c) => c.type === "image" || c.type === "image_url",
        );
        if (imageBlocks.length > 0) {
          newSentImageBlocks = new Map(entry.sentImageBlocks);
          newSentImageBlocks.set(message.timestamp, imageBlocks);
        }
      }
      return {
        sessionStates: updateSessionEntry(state.sessionStates, k, (e) => ({
          ...e,
          sentImageBlocks: newSentImageBlocks,
          messages: [...e.messages, ensureId({ ...message, seq: e.messages.length + 1 })],
        })),
      };
    }),

  truncateMessagesFrom: (index) => {
    // Always applies to the active session
    const key = get().activeSessionKey;
    set((state) => ({
      sessionStates: updateSessionEntry(state.sessionStates, key, (entry) => ({
        ...entry,
        messages: entry.messages.slice(0, index),
      })),
    }));
  },

  setSendPending: (pending, sessionKey) =>
    set((state) => ({
      sessionStates: updateSessionEntry(state.sessionStates, sessionKey, (entry) => ({
        ...entry,
        isSendPending: pending,
      })),
    })),

  setActivityLabel: (label, sessionKey) =>
    set((state) => ({
      sessionStates: updateSessionEntry(state.sessionStates, sessionKey, (entry) => ({
        ...entry,
        activityLabel: label,
      })),
    })),

  // ─── Streaming actions ───

  startStream: (runId, sessionKey) =>
    set((state) => ({
      sessionStates: updateSessionEntry(state.sessionStates, sessionKey, (entry) => ({
        ...entry,
        isStreaming: true,
        isSendPending: false,
        streamRunId: runId,
        streamContent: "",
        lastStreamEventAt: Date.now(),
        isPaused: false,
        pauseBuffer: "",
      })),
    })),

  updateStreamDelta: (runId, text, sessionKey) =>
    set((state) => {
      const k = normalizeSessionKey(sessionKey);
      const entry = state.sessionStates.get(k);
      if (!entry || entry.streamRunId !== runId) {
        return state;
      }
      // When paused, buffer the latest text but don't update visible content
      return {
        sessionStates: updateSessionEntry(state.sessionStates, k, (e) =>
          e.isPaused
            ? { ...e, pauseBuffer: text, lastStreamEventAt: Date.now() }
            : { ...e, streamContent: text, lastStreamEventAt: Date.now() },
        ),
      };
    }),

  finalizeStream: (runId, sessionKey, text, usage) =>
    set((state) => {
      const k = normalizeSessionKey(sessionKey);
      const entry = state.sessionStates.get(k);
      if (!entry || entry.streamRunId !== runId) {
        return state;
      }
      // Use buffered content if paused, otherwise latest stream/provided text
      const finalText = text ?? (entry.isPaused ? entry.pauseBuffer : entry.streamContent);
      // Guard against duplicate finalization: skip if the last message already
      // has the same runId (can happen when two "final" events arrive).
      const lastMsg = entry.messages[entry.messages.length - 1];
      const alreadyAppended = lastMsg?.runId === runId && lastMsg.role === "assistant";
      const newMessages =
        finalText.trim() && !alreadyAppended
          ? [
              ...entry.messages,
              ensureId({
                role: "assistant" as const,
                content: finalText,
                timestamp: Date.now(),
                runId,
                usage,
                seq: entry.messages.length + 1,
              }),
            ]
          : entry.messages;
      return {
        sessionStates: updateSessionEntry(state.sessionStates, k, (e) => ({
          ...e,
          messages: newMessages,
          isStreaming: false,
          isSendPending: false,
          streamRunId: null,
          streamContent: "",
          isPaused: false,
          pauseBuffer: "",
          activityLabel: "",
        })),
      };
    }),

  streamError: (runId, sessionKey, errorMessage) =>
    set((state) => {
      const k = normalizeSessionKey(sessionKey);
      const entry = state.sessionStates.get(k);
      if (!entry || entry.streamRunId !== runId) {
        return state;
      }
      const errorMsg = ensureId({
        role: "system" as const,
        content: errorMessage ?? "An error occurred",
        timestamp: Date.now(),
        runId,
        seq: entry.messages.length + 1,
      });
      return {
        sessionStates: updateSessionEntry(state.sessionStates, k, (e) => ({
          ...e,
          messages: [...e.messages, errorMsg],
          isStreaming: false,
          isSendPending: false,
          streamRunId: null,
          streamContent: "",
          isPaused: false,
          pauseBuffer: "",
          activityLabel: "",
        })),
      };
    }),

  // ─── Pause-display actions (apply to active session) ───

  pauseStream: () => {
    const key = get().activeSessionKey;
    set((state) => {
      const k = normalizeSessionKey(key);
      const entry = state.sessionStates.get(k);
      if (!entry?.isStreaming) {
        return state;
      }
      // Snapshot current content into buffer so deltas accumulate there
      return {
        sessionStates: updateSessionEntry(state.sessionStates, k, (e) => ({
          ...e,
          isPaused: true,
          pauseBuffer: e.streamContent,
        })),
      };
    });
  },

  resumeStream: () => {
    const key = get().activeSessionKey;
    set((state) => {
      const k = normalizeSessionKey(key);
      const entry = state.sessionStates.get(k);
      if (!entry?.isPaused) {
        return state;
      }
      // Flush buffered content back to visible stream
      return {
        sessionStates: updateSessionEntry(state.sessionStates, k, (e) => ({
          ...e,
          isPaused: false,
          streamContent: e.pauseBuffer,
          pauseBuffer: "",
        })),
      };
    });
  },

  // ─── Queue actions ───

  enqueueMessage: (content) =>
    set((state) => {
      // Check active session's streaming/pending state for queue auto-run logic
      const k = normalizeSessionKey(state.activeSessionKey);
      const activeSession = state.sessionStates.get(k);
      const busyNow =
        (activeSession?.isStreaming ?? false) || (activeSession?.isSendPending ?? false);
      return {
        messageQueue: [
          ...state.messageQueue,
          { id: generateUUID(), content, status: "pending" as const, addedAt: Date.now() },
        ],
        // Auto-run queue when enqueued while bot is busy — the subscriber
        // will pick up the queued message and send it when streaming finishes.
        isQueueRunning: busyNow ? true : state.isQueueRunning,
      };
    }),

  removeFromQueue: (id) =>
    set((state) => ({
      messageQueue: state.messageQueue.filter((m) => m.id !== id),
    })),

  reorderQueue: (fromIndex, toIndex) =>
    set((state) => {
      const queue = [...state.messageQueue];
      const [item] = queue.splice(fromIndex, 1);
      if (!item) {
        return state;
      }
      queue.splice(toIndex, 0, item);
      return { messageQueue: queue };
    }),

  clearQueue: () => set({ messageQueue: [], isQueueRunning: false }),

  setQueueRunning: (running) => set({ isQueueRunning: running }),

  dequeueNext: () => {
    const state = get();
    const next = state.messageQueue.find((m: QueuedMessage) => m.status === "pending");
    if (!next) {
      return null;
    }
    set({
      messageQueue: state.messageQueue.map((m: QueuedMessage) =>
        m.id === next.id ? { ...m, status: "sending" as const } : m,
      ),
    });
    return next;
  },

  setThinkingLevel: (level) => set({ thinkingLevel: level }),
  setPendingModelId: (modelId) => set({ pendingModelId: modelId }),

  // ─── Draft actions ───

  getDraft: (sessionKey) => get().drafts[sessionKey] ?? emptyDraft,

  setDraftInput: (sessionKey, value) =>
    set((state) => ({
      drafts: {
        ...state.drafts,
        [sessionKey]: {
          ...(state.drafts[sessionKey] ?? emptyDraft),
          inputValue: value,
        },
      },
    })),

  setDraftAttachments: (sessionKey, attachments) =>
    set((state) => ({
      drafts: {
        ...state.drafts,
        [sessionKey]: {
          ...(state.drafts[sessionKey] ?? emptyDraft),
          attachments,
        },
      },
    })),

  clearDraft: (sessionKey) =>
    set((state) => {
      const { [sessionKey]: _, ...rest } = state.drafts;
      return { drafts: rest };
    }),

  reset: () => set(initialState),
}));

// Persist queue to localStorage on every change
useChatStore.subscribe((state, prev) => {
  if (state.messageQueue !== prev.messageQueue || state.isQueueRunning !== prev.isQueueRunning) {
    persistQueue(state.messageQueue, state.isQueueRunning);
  }
});

// Persist active session key so returning to chat restores the last-viewed session
useChatStore.subscribe((state, prev) => {
  if (state.activeSessionKey !== prev.activeSessionKey) {
    try {
      localStorage.setItem(ACTIVE_SESSION_KEY, state.activeSessionKey);
    } catch {
      /* ignore */
    }
  }
});
