import type { TasksHistoryResult } from "../../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { extractTextCached } from "../../../lib/chat/message-extract.ts";
import { visibleChatHistoryMessages } from "../../../lib/chat/message-visibility.ts";
import type { UiSessionDefaultsHost } from "../../../lib/sessions/session-key.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import { readChatThreadMessageIdentity } from "../chat-thread-items.ts";
import { setExpansionState, type AssistantMessageExpansionState } from "../chat-thread.ts";
import type { SidebarFullMessageLoader } from "./chat-sidebar-content-types.ts";

const TASK_TRANSCRIPT_REFRESH_MS = 2_000;
const TASK_TRANSCRIPT_REQUEST_LIMIT = 100;

type LoadedTaskTranscript = {
  status: "loaded";
  messages: unknown[];
  nextCursor?: string;
  loading: boolean;
  error?: "refresh" | "older";
};

type TaskTranscriptLoad = { status: "loading" } | LoadedTaskTranscript | { status: "error" };

type TaskDetailState = {
  client: GatewayBrowserClient;
  connectionEpoch: number | undefined;
  refreshPending: boolean;
  inFlight: boolean;
  lastRequestStartedAt: number;
  load: TaskTranscriptLoad;
  refreshTimer: number | null;
  olderCursors: Set<string>;
  taskId: string;
  fullMessages: Map<string, AssistantMessageExpansionState>;
};

export type TaskDetailHost = UiSessionDefaultsHost & {
  sessionKey: string;
  client: GatewayBrowserClient | null;
  connected: boolean;
  connectionEpoch?: number;
  requestUpdate?: () => void;
  taskDetailState?: TaskDetailState;
};

function clearRefreshTimer(state: TaskDetailState) {
  if (state.refreshTimer !== null) {
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }
}

export function resetTaskDetail(host: TaskDetailHost) {
  const current = host.taskDetailState;
  if (!current) {
    return;
  }
  clearRefreshTimer(current);
  current.fullMessages.clear();
  host.taskDetailState = undefined;
}

export async function requestTaskFullMessage(
  host: TaskDetailHost,
  {
    loader,
    ...request
  }: Parameters<SidebarFullMessageLoader>[0] & { loader: SidebarFullMessageLoader },
) {
  const state = host.taskDetailState;
  if (
    !state ||
    !host.connected ||
    host.client !== state.client ||
    host.connectionEpoch !== state.connectionEpoch
  ) {
    return;
  }
  const current = state.fullMessages.get(request.messageId);
  if (current?.status === "loading" || current?.status === "loaded") {
    return;
  }
  const revision = (current?.revision ?? 0) + 1;
  const pending = { status: "loading", revision } as const;
  setExpansionState(state.fullMessages, request.messageId, pending);
  host.requestUpdate?.();
  let result: Awaited<ReturnType<SidebarFullMessageLoader>>;
  try {
    result = await loader(request);
  } catch {
    result = null;
  }
  // Reset or reconnection can reuse both the message ID and revision.
  if (
    host.taskDetailState !== state ||
    host.client !== state.client ||
    host.connectionEpoch !== state.connectionEpoch ||
    state.fullMessages.get(request.messageId) !== pending
  ) {
    return;
  }
  const markdown =
    result?.ok && result.message && typeof result.message === "object"
      ? extractTextCached(result.message)
      : null;
  setExpansionState(
    state.fullMessages,
    request.messageId,
    markdown === null
      ? { status: "error", revision: revision + 1 }
      : { status: "loaded", markdown, revision: revision + 1 },
  );
  host.requestUpdate?.();
}

function scheduleTranscriptLoad(host: TaskDetailHost, state: TaskDetailState) {
  if (host.taskDetailState !== state || state.inFlight) {
    return;
  }
  const remaining = TASK_TRANSCRIPT_REFRESH_MS - (Date.now() - state.lastRequestStartedAt);
  if (remaining > 0) {
    if (state.refreshTimer === null) {
      state.refreshTimer = window.setTimeout(() => {
        state.refreshTimer = null;
        scheduleTranscriptLoad(host, state);
      }, remaining);
    }
    return;
  }
  clearRefreshTimer(state);
  void loadTranscriptPage(host, state);
}

function transcriptEntryKey(message: unknown): string | undefined {
  const identity = readChatThreadMessageIdentity(message);
  if (!identity) {
    return undefined;
  }
  return identity.externalSource
    ? `external:${identity.externalSource}`
    : identity.id
      ? `id:${identity.id}`
      : identity.sequence == null
        ? undefined
        : `seq:${identity.sequence}`;
}

function transcriptOverlap(earlier: unknown[], later: unknown[]): number {
  const laterKeys = new Set(later.map(transcriptEntryKey).filter(Boolean));
  return earlier.findIndex((message) => {
    const key = transcriptEntryKey(message);
    return key !== undefined && laterKeys.has(key);
  });
}

async function loadTranscriptPage(host: TaskDetailHost, state: TaskDetailState, cursor?: string) {
  if (host.taskDetailState !== state || state.inFlight) {
    return;
  }
  const client = host.client;
  if (
    !client ||
    !host.connected ||
    client !== state.client ||
    host.connectionEpoch !== state.connectionEpoch
  ) {
    state.load = { status: "error" };
    host.requestUpdate?.();
    return;
  }
  const previous = state.load.status === "loaded" ? state.load : undefined;
  state.inFlight = true;
  if (!cursor) {
    state.lastRequestStartedAt = Date.now();
    state.refreshPending = false;
  }
  state.load = previous ? { ...previous, loading: true, error: undefined } : { status: "loading" };
  host.requestUpdate?.();
  let load: TaskTranscriptLoad;
  try {
    const result = await client.request<TasksHistoryResult>("tasks.history", {
      taskId: state.taskId,
      limit: TASK_TRANSCRIPT_REQUEST_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    const messages = visibleChatHistoryMessages(result.messages);
    const previousMessages = previous?.messages ?? [];
    const earlier = cursor ? messages : previousMessages;
    const later = cursor ? previousMessages : messages;
    const overlap = transcriptOverlap(earlier, later);
    const retainPrevious = previous !== undefined && (cursor !== undefined || overlap >= 0);
    if (cursor) {
      state.olderCursors.add(cursor);
    } else if (!retainPrevious) {
      // A disjoint tail may have skipped whole pages. Restart pagination from
      // that tail so Show earlier can reach every intervening message.
      state.olderCursors.clear();
    }
    load = {
      status: "loaded",
      // Replace whole overlapping entries, including their projected siblings.
      messages: retainPrevious
        ? [...earlier.slice(0, overlap < 0 ? earlier.length : overlap), ...later]
        : messages,
      // Only overlapping refreshes preserve the oldest boundary already loaded.
      nextCursor:
        retainPrevious && !cursor
          ? previous.nextCursor
          : result.nextCursor && !state.olderCursors.has(result.nextCursor)
            ? result.nextCursor
            : undefined,
      loading: false,
    };
  } catch {
    load = previous
      ? { ...previous, loading: false, error: cursor ? "older" : "refresh" }
      : { status: "error" };
  }
  const current = host.taskDetailState;
  if (
    current !== state ||
    host.client !== client ||
    host.connectionEpoch !== state.connectionEpoch
  ) {
    return;
  }
  state.inFlight = false;
  state.load = load;
  host.requestUpdate?.();
  // Also refresh after events received during an older-page request.
  if (state.refreshPending) {
    scheduleTranscriptLoad(host, state);
  }
}

export function readTaskTranscript(
  host: TaskDetailHost,
  selection: { taskId: string },
): TaskTranscriptLoad {
  const client = host.client;
  const current = host.taskDetailState;
  if (
    current &&
    current.taskId === selection.taskId &&
    current.client === client &&
    current.connectionEpoch === host.connectionEpoch
  ) {
    return current.load;
  }
  resetTaskDetail(host);
  if (!client || !host.connected) {
    return { status: "error" };
  }
  const next: TaskDetailState = {
    client,
    connectionEpoch: host.connectionEpoch,
    refreshPending: false,
    inFlight: false,
    lastRequestStartedAt: Number.NEGATIVE_INFINITY,
    load: { status: "loading" },
    refreshTimer: null,
    olderCursors: new Set(),
    taskId: selection.taskId,
    fullMessages: new Map(),
  };
  host.taskDetailState = next;
  scheduleTranscriptLoad(host, next);
  return next.load;
}

export function loadOlderTaskTranscript(host: TaskDetailHost) {
  const state = host.taskDetailState;
  if (state?.load.status === "loaded" && state.load.nextCursor) {
    void loadTranscriptPage(host, state, state.load.nextCursor);
  }
}

export function retryTaskTranscript(host: TaskDetailHost) {
  const state = host.taskDetailState;
  if (!state) {
    host.requestUpdate?.();
    return;
  }
  if (state.load.status === "loaded" && state.load.error === "older") {
    loadOlderTaskTranscript(host);
  } else {
    clearRefreshTimer(state);
    void loadTranscriptPage(host, state);
  }
}

export function observeTaskDetailEvent(
  host: TaskDetailHost,
  event:
    | { action: "upserted"; task: TaskSummary }
    | { action: "deleted"; taskId: string }
    | { action: "restored" },
) {
  const state = host.taskDetailState;
  if (!state) {
    return;
  }
  if (event.action === "deleted") {
    if (event.taskId === state.taskId) {
      resetTaskDetail(host);
    }
    return;
  }
  if (event.action !== "upserted" || event.task.id !== state.taskId) {
    return;
  }
  state.refreshPending = true;
  // Terminal events remain pending through an in-flight or throttled read,
  // so the next request is always the final task-session snapshot.
  scheduleTranscriptLoad(host, state);
}
