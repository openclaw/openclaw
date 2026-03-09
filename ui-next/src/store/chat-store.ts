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

export type ChatState = {
  // Session management
  activeSessionKey: string;
  sessions: SessionEntry[];
  sessionsLoading: boolean;

  // Messages
  messages: ChatMessage[];
  messagesLoading: boolean;

  // Streaming state
  isStreaming: boolean;
  streamRunId: string | null;
  streamContent: string;
  /** Timestamp (ms) of last stream event — used to detect stuck streams */
  lastStreamEventAt: number;

  // Pause-display: UI pauses rendering deltas while backend continues
  isPaused: boolean;
  /** Content buffered while paused (flushed on resume) */
  pauseBuffer: string;

  // Send-pending state (typing indicator before server acks)
  isSendPending: boolean;

  // Message queue (batch execution)
  messageQueue: QueuedMessage[];
  isQueueRunning: boolean;

  // Thinking level from history
  thinkingLevel: string;

  // Per-session drafts (input text + attachments preserved across navigation)
  drafts: Record<string, SessionDraft>;

  // Actions
  setActiveSessionKey: (key: string) => void;
  setSessions: (sessions: SessionEntry[]) => void;
  setSessionsLoading: (loading: boolean) => void;
  setMessages: (messages: Array<Omit<ChatMessage, "id"> & { id?: string }>) => void;
  setMessagesLoading: (loading: boolean) => void;
  appendMessage: (message: Omit<ChatMessage, "id"> & { id?: string }) => void;
  /** Remove messages from index onwards (used by regenerate to drop the last exchange) */
  truncateMessagesFrom: (index: number) => void;

  // Send-pending actions
  setSendPending: (pending: boolean) => void;

  // Streaming actions
  startStream: (runId: string) => void;
  updateStreamDelta: (runId: string, text: string) => void;
  finalizeStream: (runId: string, text?: string, usage?: MessageUsage) => void;
  streamError: (runId: string, errorMessage?: string) => void;

  // Pause-display actions
  pauseStream: () => void;
  resumeStream: () => void;

  // Queue actions
  enqueueMessage: (content: string | ChatMessageContent[]) => void;
  removeFromQueue: (id: string) => void;
  reorderQueue: (fromIndex: number, toIndex: number) => void;
  clearQueue: () => void;
  setQueueRunning: (running: boolean) => void;
  /** Shift the first pending item to 'sending' and return it, or null if empty. */
  dequeueNext: () => QueuedMessage | null;

  setThinkingLevel: (level: string) => void;

  // Draft actions
  getDraft: (sessionKey: string) => SessionDraft;
  setDraftInput: (sessionKey: string, value: string) => void;
  setDraftAttachments: (sessionKey: string, attachments: DraftAttachment[]) => void;
  clearDraft: (sessionKey: string) => void;

  reset: () => void;
};

/** Extract plain text from message content (string or content array). */
export function getMessageText(msg: ChatMessage): string {
  if (typeof msg.content === "string") {
    return msg.content;
  }
  const parts = msg.content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("");
  return parts;
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

const initialState = {
  activeSessionKey: "main",
  sessions: [] as SessionEntry[],
  sessionsLoading: false,
  messages: [] as ChatMessage[],
  messagesLoading: false,
  isStreaming: false,
  streamRunId: null as string | null,
  streamContent: "",
  lastStreamEventAt: 0,
  isPaused: false,
  pauseBuffer: "",
  isSendPending: false,
  messageQueue: restoredQueue.messageQueue,
  isQueueRunning: restoredQueue.isQueueRunning,
  thinkingLevel: "off",
  drafts: {} as Record<string, SessionDraft>,
};

export const useChatStore = create<ChatState>((set, get) => ({
  ...initialState,

  setActiveSessionKey: (key) => set({ activeSessionKey: key }),

  setSessions: (sessions) => set({ sessions }),
  setSessionsLoading: (loading) => set({ sessionsLoading: loading }),

  setMessages: (messages) => {
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
    set({
      messages: deduped.map((m, i) => ensureId({ ...m, seq: i + 1 })),
      isSendPending: false,
    });
  },
  setMessagesLoading: (loading) => set({ messagesLoading: loading }),

  appendMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, ensureId({ ...message, seq: state.messages.length + 1 })],
    })),

  truncateMessagesFrom: (index) =>
    set((state) => ({
      messages: state.messages.slice(0, index),
    })),

  setSendPending: (pending) => set({ isSendPending: pending }),

  startStream: (runId) =>
    set({
      isStreaming: true,
      isSendPending: false,
      streamRunId: runId,
      streamContent: "",
      lastStreamEventAt: Date.now(),
      isPaused: false,
      pauseBuffer: "",
    }),

  updateStreamDelta: (runId, text) =>
    set((state) => {
      if (state.streamRunId !== runId) {
        return state;
      }
      // When paused, buffer the latest text but don't update visible content
      if (state.isPaused) {
        return { pauseBuffer: text, lastStreamEventAt: Date.now() };
      }
      return { streamContent: text, lastStreamEventAt: Date.now() };
    }),

  finalizeStream: (runId, text, usage) =>
    set((state) => {
      if (state.streamRunId !== runId) {
        return state;
      }
      // Use buffered content if paused, otherwise latest stream/provided text
      const finalText = text ?? (state.isPaused ? state.pauseBuffer : state.streamContent);
      // Guard against duplicate finalization: skip if the last message already
      // has the same runId (can happen when two "final" events arrive).
      const lastMsg = state.messages[state.messages.length - 1];
      const alreadyAppended = lastMsg?.runId === runId && lastMsg.role === "assistant";
      const newMessages =
        finalText.trim() && !alreadyAppended
          ? [
              ...state.messages,
              ensureId({
                role: "assistant" as const,
                content: finalText,
                timestamp: Date.now(),
                runId,
                usage,
                seq: state.messages.length + 1,
              }),
            ]
          : state.messages;
      return {
        messages: newMessages,
        isStreaming: false,
        isSendPending: false,
        streamRunId: null,
        streamContent: "",
        isPaused: false,
        pauseBuffer: "",
      };
    }),

  streamError: (runId, errorMessage) =>
    set((state) => {
      if (state.streamRunId !== runId) {
        return state;
      }
      const errorMsg = ensureId({
        role: "system" as const,
        content: errorMessage ?? "An error occurred",
        timestamp: Date.now(),
        runId,
        seq: state.messages.length + 1,
      });
      return {
        messages: [...state.messages, errorMsg],
        isStreaming: false,
        isSendPending: false,
        streamRunId: null,
        streamContent: "",
        isPaused: false,
        pauseBuffer: "",
      };
    }),

  pauseStream: () =>
    set((state) => {
      if (!state.isStreaming) {
        return state;
      }
      // Snapshot current content into buffer so deltas accumulate there
      return { isPaused: true, pauseBuffer: state.streamContent };
    }),

  resumeStream: () =>
    set((state) => {
      if (!state.isPaused) {
        return state;
      }
      // Flush buffered content back to visible stream
      return { isPaused: false, streamContent: state.pauseBuffer, pauseBuffer: "" };
    }),

  // Queue actions
  enqueueMessage: (content) =>
    set((state) => ({
      messageQueue: [
        ...state.messageQueue,
        { id: generateUUID(), content, status: "pending" as const, addedAt: Date.now() },
      ],
      // Auto-run queue when enqueued while bot is busy — the subscriber
      // will pick up the queued message and send it when streaming finishes.
      isQueueRunning: state.isStreaming || state.isSendPending ? true : state.isQueueRunning,
    })),

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

  // Draft actions
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
