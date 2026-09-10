import type { TasksHistoryResult } from "../../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { visibleChatHistoryMessages } from "../../../lib/chat/message-visibility.ts";
import type { UiSessionDefaultsHost } from "../../../lib/sessions/session-key.ts";
import { isActiveTask, newestTaskSnapshot } from "../../../lib/tasks/data.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import { catalogItemMessage } from "../catalog-item-message.ts";
import type { ChatHistoryResult } from "../chat-history-snapshot.ts";

const TASK_TRANSCRIPT_REFRESH_MS = 2_000;
const TASK_TRANSCRIPT_RETRY_MS = 10_000;
// Keep the session preview window and native paginated history bounded.
const TASK_TRANSCRIPT_REQUEST_LIMIT = 800;

type TaskHistoryPage = TasksHistoryResult;

type TaskTranscriptLoad =
  | { status: "loading" }
  | {
      status: "loaded";
      messages: unknown[];
      nextCursor?: string;
      loadingOlder?: boolean;
      olderError?: boolean;
    }
  | { status: "error" };

type TaskDetailState = {
  client: GatewayBrowserClient;
  connectionEpoch: number | undefined;
  eventVersion: number;
  inFlight: boolean;
  lastRequestStartedAt: number;
  load: TaskTranscriptLoad;
  refreshTimer: number | null;
  requestId: number;
  sessionKey?: string;
  native: boolean;
  active: boolean;
  items: TaskHistoryPage["items"];
  hasOlderPages: boolean;
  taskId: string;
  task?: TaskSummary;
};

export type TaskDetailHost = UiSessionDefaultsHost & {
  sessionKey: string;
  client: GatewayBrowserClient | null;
  connected: boolean;
  connectionEpoch?: number;
  requestUpdate?: () => void;
  sessionsResultAgentId?: string | null;
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
  host.taskDetailState = undefined;
}

function scheduleTranscriptLoad(
  host: TaskDetailHost,
  state: TaskDetailState,
  olderCursor?: string,
) {
  if (host.taskDetailState !== state || state.inFlight) {
    return;
  }
  const interval =
    state.native && state.load.status === "error"
      ? TASK_TRANSCRIPT_RETRY_MS
      : TASK_TRANSCRIPT_REFRESH_MS;
  const remaining = interval - (Date.now() - state.lastRequestStartedAt);
  if (!olderCursor && remaining > 0) {
    if (state.refreshTimer === null) {
      state.refreshTimer = window.setTimeout(() => {
        state.refreshTimer = null;
        scheduleTranscriptLoad(host, state);
      }, remaining);
    }
    return;
  }
  clearRefreshTimer(state);
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
  const requestId = ++state.requestId;
  const eventVersion = state.eventVersion;
  state.inFlight = true;
  state.lastRequestStartedAt = Date.now();
  if (state.load.status !== "loaded" && !(state.native && state.load.status === "error")) {
    state.load = { status: "loading" };
  }
  if (olderCursor && state.load.status === "loaded") {
    state.load = { ...state.load, loadingOlder: true, olderError: false };
  }
  host.requestUpdate?.();
  void (async () => {
    let load: TaskTranscriptLoad;
    try {
      if (state.native) {
        // Task status, not the parent run, owns this inspector's polling lifetime.
        const { task } = await client.request<{ task: TaskSummary }>("tasks.get", {
          taskId: state.taskId,
        });
        if (
          host.taskDetailState !== state ||
          !host.connected ||
          host.client !== client ||
          host.connectionEpoch !== state.connectionEpoch
        ) {
          return;
        }
        const page = await client.request<TaskHistoryPage>("tasks.history", {
          taskId: state.taskId,
          limit: 100,
          ...(olderCursor ? { cursor: olderCursor } : {}),
        });
        if (
          host.taskDetailState !== state ||
          !host.connected ||
          host.client !== client ||
          host.connectionEpoch !== state.connectionEpoch
        ) {
          return;
        }
        if (page.taskId !== state.taskId || task.id !== state.taskId) {
          throw new Error("Task history identity changed");
        }
        if (state.eventVersion === eventVersion) {
          state.active = isActiveTask(task);
          state.task = task;
        }
        const incoming = page.items.filter((item) => item.type !== "reasoning");
        const combined = olderCursor
          ? [...state.items, ...incoming]
          : state.hasOlderPages
            ? [...incoming, ...state.items]
            : incoming;
        const seen = new Set<string>();
        state.items = combined
          .filter((item) => {
            if (seen.has(item.id)) {
              return false;
            }
            seen.add(item.id);
            return true;
          })
          .slice(0, TASK_TRANSCRIPT_REQUEST_LIMIT);
        const nextCursor =
          olderCursor || !state.hasOlderPages || state.load.status !== "loaded"
            ? page.nextCursor
            : state.load.nextCursor;
        if (olderCursor) {
          state.hasOlderPages = true;
        }
        load = {
          status: "loaded",
          messages: state.items
            .toReversed()
            .map(catalogItemMessage)
            .filter((message) => message !== null),
          ...(state.items.length < TASK_TRANSCRIPT_REQUEST_LIMIT && nextCursor
            ? { nextCursor }
            : {}),
        };
      } else {
        const result = await client.request<ChatHistoryResult>("chat.history", {
          sessionKey: state.sessionKey,
          limit: TASK_TRANSCRIPT_REQUEST_LIMIT,
        });
        load = { status: "loaded", messages: visibleChatHistoryMessages(result.messages) };
      }
    } catch {
      load =
        olderCursor && state.load.status === "loaded"
          ? { ...state.load, loadingOlder: false, olderError: true }
          : { status: "error" };
    }
    const current = host.taskDetailState;
    if (
      !host.connected ||
      current !== state ||
      current.requestId !== requestId ||
      host.client !== client ||
      host.connectionEpoch !== state.connectionEpoch
    ) {
      return;
    }
    state.inFlight = false;
    state.load = load;
    host.requestUpdate?.();
    // Events that arrived during this request own a later snapshot. This also
    // guarantees one final history read after a terminal transition.
    if (state.eventVersion > eventVersion || (state.native && state.active)) {
      scheduleTranscriptLoad(host, state);
    }
  })();
}

export function readTaskTranscript(
  host: TaskDetailHost,
  selection:
    | { taskId: string; sessionKey: string }
    | { taskId: string; native: true; active: boolean },
): TaskTranscriptLoad {
  const client = host.client;
  const native = "native" in selection;
  const sessionKey = "sessionKey" in selection ? selection.sessionKey : undefined;
  const current = host.taskDetailState;
  if (
    current &&
    current.taskId === selection.taskId &&
    host.connected &&
    current.native === native &&
    current.sessionKey === sessionKey &&
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
    eventVersion: 0,
    inFlight: false,
    lastRequestStartedAt: Number.NEGATIVE_INFINITY,
    load: { status: "loading" },
    refreshTimer: null,
    requestId: 0,
    sessionKey,
    native,
    active: native && selection.active,
    items: [],
    hasOlderPages: false,
    taskId: selection.taskId,
  };
  host.taskDetailState = next;
  scheduleTranscriptLoad(host, next);
  return next.load;
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
  state.active = isActiveTask(event.task);
  state.eventVersion += 1;
  // A terminal version remains pending through an in-flight or throttled read,
  // so the next request is always the final task-session snapshot.
  scheduleTranscriptLoad(host, state);
}

export function loadOlderTaskTranscript(host: TaskDetailHost) {
  const state = host.taskDetailState;
  if (state?.native && state.load.status === "loaded" && state.load.nextCursor) {
    scheduleTranscriptLoad(host, state, state.load.nextCursor);
  }
}

/** The inspector's own reads also advance its header when no parent events arrive. */
export function readTaskDetailSnapshot(host: TaskDetailHost, task: TaskSummary): TaskSummary {
  const state = host.taskDetailState;
  return state?.taskId === task.id &&
    host.connected &&
    state.client === host.client &&
    state.connectionEpoch === host.connectionEpoch
    ? newestTaskSnapshot(task, state.task)
    : task;
}
