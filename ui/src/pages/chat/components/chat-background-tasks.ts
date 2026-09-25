import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GatewayRequestError,
  type GatewayBrowserClient,
  type GatewayHelloOk,
} from "../../../api/gateway.ts";
import { hasOperatorWriteAccess } from "../../../app/operator-access.ts";
import { t } from "../../../i18n/index.ts";
import { registerBackgroundTasksEnglish } from "../../../i18n/locales/en-background-tasks.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import type { SessionScopeHost } from "../../../lib/sessions/index.ts";
import {
  canonicalUiSessionKeyForPersistence,
  resolveUiConversationIdentity,
} from "../../../lib/sessions/session-key.ts";
import {
  coalesceTaskEvent,
  type CoalescedTaskEvent,
  isActiveTask,
  mergeTaskLists,
  newestTaskSnapshot,
  normalizeTaskEventPayload,
  normalizeTasksCancelResult,
  normalizeTasksGetResult,
  normalizeTasksListResult,
  replayTaskEvents,
  sortTasks,
} from "../../../lib/tasks/data.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import { taskMatchesSessionScope } from "./chat-background-task-scope.ts";
import {
  prepareTaskSnapshot,
  type BackgroundTaskObservations,
} from "./chat-background-tasks-shared.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import { deriveSubagentActivity } from "./chat-subagent-activity.ts";
import {
  observeTaskDetailEvent,
  resetTaskDetail,
  type TaskTranscriptHost,
} from "./chat-task-detail-state.ts";

registerBackgroundTasksEnglish();

type BackgroundTaskLoadEvent = NonNullable<ReturnType<typeof normalizeTaskEventPayload>>;

type BackgroundTaskEventBuffer = {
  requestId: number;
  events: Map<string, CoalescedTaskEvent>;
};

type BackgroundTaskSnapshotResult =
  | { kind: "ready"; active: unknown; recent: unknown }
  | { kind: "deferred"; retryAttempt: number }
  | { kind: "stale" };

type BackgroundTasksState = BackgroundTaskObservations & {
  cancellingTaskIds: Set<string>;
  collapsed: boolean;
  connectionClient: GatewayBrowserClient | null;
  connectionEpoch: number | undefined;
  error: string | null;
  errorTaskId?: string;
  explicitReadRequested: boolean;
  deferredRetryAttempt?: number;
  finishedCollapsed: boolean;
  // Loads are keyed to the client so a reconnect (or gateway switch) refreshes
  // the snapshot instead of trusting the previous connection's task list.
  loadedClient: GatewayBrowserClient | null;
  loading: boolean;
  pendingTaskEvents: BackgroundTaskEventBuffer | null;
  pendingReload: boolean;
  requestId: number;
  sessionKey: string;
  agentId?: string;
  // wa-tooltip anchors by document id, so the status row's id must stay unique
  // per pane: two panes on the same agent would otherwise cross-anchor.
  statusRowId: string;
  tasks: TaskSummary[] | null;
  taskDetails: Map<string, TaskSummary>;
  taskDetailErrors: Map<string, string>;
  taskDetailRequests: Map<string, symbol>;
};

export type BackgroundTasksHost = TaskTranscriptHost & {
  sessionKey: string;
  assistantAgentId?: string | null;
  hello: GatewayHelloOk | null;
  agentsList?: SessionScopeHost["agentsList"];
  backgroundTasksState?: BackgroundTasksState;
  chatSecondaryReadsReady?: (explicit?: boolean) => boolean;
};

// The chat rail stays bounded to its session while the full Tasks page drains
// every active page. A separate active query still keeps long-running work
// from hiding behind newer terminal records here.
const ACTIVE_TASKS_LIMIT = 200;
const RECENT_TASKS_LIMIT = 100;
const TASK_LIST_MAX_ATTEMPTS = 2;
const TASK_LIST_RETRY_DEFAULT_MS = 250;
const TASK_LIST_RETRY_MAX_MS = 30_000;

let nextStatusRowId = 0;

function getBackgroundTasksState(host: BackgroundTasksHost): BackgroundTasksState {
  const { sessionKey, agentId } = resolveUiConversationIdentity(host, host.sessionKey);
  const current = host.backgroundTasksState;
  if (
    current?.sessionKey === sessionKey &&
    current.agentId === agentId &&
    current.connectionClient === host.client &&
    current.connectionEpoch === host.connectionEpoch
  ) {
    return current;
  }
  resetTaskDetail(host);
  nextStatusRowId += 1;
  const next: BackgroundTasksState = {
    cancellingTaskIds: new Set(),
    // Keep presentation choices across thread switches while discarding all
    // task data and private details from the previous session scope.
    collapsed: current?.collapsed ?? true,
    // The pane increments this epoch even when a reconnect reuses its client.
    // Old snapshots and private task details must never enter the new scope.
    connectionClient: host.client,
    connectionEpoch: host.connectionEpoch,
    error: null,
    explicitReadRequested: false,
    // Finished history starts collapsed so active work owns the rail; the
    // section header still shows the count for discoverability.
    finishedCollapsed: current?.finishedCollapsed ?? true,
    loadedClient: null,
    loading: false,
    pendingTaskEvents: null,
    pendingReload: false,
    requestId: 0,
    sessionKey,
    agentId,
    statusRowId: `chat-tasks-status-${nextStatusRowId}`,
    taskActivityById: new Map(),
    tasks: null,
    taskDetails: new Map(),
    taskDetailErrors: new Map(),
    taskDetailRequests: new Map(),
  };
  host.backgroundTasksState = next;
  return next;
}

function taskListRetryDelayMs(error: unknown): number | undefined {
  if (!(error instanceof GatewayRequestError) || !error.retryable) {
    return undefined;
  }
  return Math.min(
    TASK_LIST_RETRY_MAX_MS,
    Math.max(
      0,
      typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs)
        ? error.retryAfterMs
        : TASK_LIST_RETRY_DEFAULT_MS,
    ),
  );
}

async function requestTaskSnapshot(
  host: BackgroundTasksHost,
  state: BackgroundTasksState,
  client: GatewayBrowserClient,
  requestId: number,
): Promise<BackgroundTaskSnapshotResult> {
  const { sessionKey, agentId } = state;
  const retryAttempt = state.deferredRetryAttempt ?? 0;
  delete state.deferredRetryAttempt;
  for (let attempt = retryAttempt; attempt < TASK_LIST_MAX_ATTEMPTS; attempt += 1) {
    if (
      !host.connected ||
      host.client !== client ||
      getBackgroundTasksState(host) !== state ||
      state.requestId !== requestId
    ) {
      return { kind: "stale" };
    }
    if (host.chatSecondaryReadsReady?.(state.explicitReadRequested) === false) {
      return { kind: "deferred", retryAttempt: attempt };
    }
    const results = await Promise.allSettled([
      client.request("tasks.list", {
        sessionKey,
        agentId,
        status: ["queued", "running"],
        limit: ACTIVE_TASKS_LIMIT,
      }),
      client.request("tasks.list", {
        sessionKey,
        agentId,
        status: ["completed", "failed", "timed_out", "cancelled"],
        sortBy: "endedAt",
        limit: RECENT_TASKS_LIMIT,
      }),
    ]);
    const [active, recent] = results;
    if (active?.status === "fulfilled" && recent?.status === "fulfilled") {
      return { kind: "ready", active: active.value, recent: recent.value };
    }
    const failures = results.filter((result) => result.status === "rejected");
    const error = failures[0]?.reason;
    let retryDelayMs = 0;
    for (const failure of failures) {
      const delay = taskListRetryDelayMs(failure.reason);
      if (delay === undefined) {
        throw failure.reason;
      }
      retryDelayMs = Math.max(retryDelayMs, delay);
    }
    if (attempt === TASK_LIST_MAX_ATTEMPTS - 1) {
      throw error;
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, retryDelayMs);
    });
  }
  throw new Error("unreachable task list retry state");
}

function loadBackgroundTasks(
  host: BackgroundTasksHost,
  state: BackgroundTasksState,
  force = false,
) {
  const client = host.client;
  if (!client || !host.connected || getBackgroundTasksState(host) !== state) {
    return;
  }
  if (state.loading) {
    state.pendingReload ||= force;
    return;
  }
  const requestId = ++state.requestId;
  // The state owns the client and conversation pair; its request owns this
  // buffer so late pages cannot resurrect an unopened concurrent task.
  const buffer: BackgroundTaskEventBuffer = {
    requestId,
    events: state.pendingTaskEvents?.events ?? new Map(),
  };
  state.pendingTaskEvents = buffer;
  state.loading = true;
  state.error = null;
  delete state.errorTaskId;
  state.pendingReload = false;
  host.requestUpdate?.();
  void (async () => {
    try {
      const result = await requestTaskSnapshot(host, state, client, requestId);
      const current = getBackgroundTasksState(host);
      if (current !== state || current.requestId !== requestId || result.kind === "stale") {
        return;
      }
      if (result.kind === "deferred") {
        current.deferredRetryAttempt = current.pendingReload ? 0 : result.retryAttempt;
        current.pendingReload = true;
        return;
      }
      const active = normalizeTasksListResult(result.active)?.tasks.map((task) =>
        prepareTaskSnapshot(state, task),
      );
      const recent = normalizeTasksListResult(result.recent)?.tasks.map((task) =>
        prepareTaskSnapshot(state, task),
      );
      if (!active || !recent) {
        throw new Error(t("tasksPage.invalidResponse"));
      }
      // The active query is issued first. Apply the later recent snapshot last
      // so same-millisecond running progress cannot regress when events drop.
      const merged = replayTaskEvents(mergeTaskLists(active, recent), buffer.events);
      current.tasks = sortTasks(
        merged.map((task) => newestTaskSnapshot(task, current.taskDetails.get(task.id))),
      );
      current.loadedClient = client;
    } catch (error) {
      const current = getBackgroundTasksState(host);
      if (current === state && current.requestId === requestId) {
        if (current.tasks === null && buffer.events.size > 0) {
          // Real registry events remain authoritative when an initial page
          // fails; discarding them would hide active work and completions.
          current.tasks = replayTaskEvents([], buffer.events);
        }
        current.error = formatUiError(error, t("tasksPage.loadFailed"));
        delete current.errorTaskId;
      }
    } finally {
      const current = getBackgroundTasksState(host);
      if (current === state && current.requestId === requestId) {
        if (current.pendingTaskEvents === buffer && current.deferredRetryAttempt === undefined) {
          current.pendingTaskEvents = null;
        }
        current.loading = false;
        const reload = current.pendingReload;
        current.pendingReload = false;
        if (reload && host.chatSecondaryReadsReady?.(current.explicitReadRequested) !== false) {
          loadBackgroundTasks(host, current, true);
        } else if (reload) {
          current.loadedClient = null;
          // The superseded read's error must not block its queued replacement on resume.
          current.error = null;
          delete current.errorTaskId;
        }
      }
      host.requestUpdate?.();
    }
  })();
}

function bufferBackgroundTaskEvent(
  state: BackgroundTasksState,
  event: BackgroundTaskLoadEvent,
): boolean {
  if (event.action === "restored") {
    return false;
  }
  const buffer = (state.pendingTaskEvents ??=
    state.tasks === null ? { requestId: state.requestId, events: new Map() } : null);
  if (!buffer || buffer.requestId !== state.requestId) {
    return false;
  }
  coalesceTaskEvent(buffer.events, event);
  return state.loading;
}

/** Apply a gateway `task` event to the pane's snapshot. Events for other
 * sessions are ignored; a registry restore forces a refetch. */
export function handleBackgroundTasksEvent(
  host: BackgroundTasksHost,
  payload: unknown,
  presented = true,
) {
  const state = host.backgroundTasksState;
  if (!state || getBackgroundTasksState(host) !== state) {
    return;
  }
  let normalizedEvent = normalizeTaskEventPayload(payload);
  if (!normalizedEvent) {
    return;
  }
  if (normalizedEvent.action === "upserted") {
    const match = taskMatchesSessionScope(host, normalizedEvent.task, state);
    if (match === "ignore") {
      return;
    }
    if (match === "refresh") {
      // Ambiguous events invalidate like a restore: coalesce visible reloads
      // and defer hidden panes until presentation without adopting the event.
      normalizedEvent = { action: "restored" };
    }
  }
  observeTaskDetailEvent(host, normalizedEvent);
  const event =
    normalizedEvent.action === "upserted"
      ? {
          ...normalizedEvent,
          task: prepareTaskSnapshot(state, normalizedEvent.task),
        }
      : normalizedEvent;
  const bufferedEvent = bufferBackgroundTaskEvent(state, event);
  const readReady =
    presented && host.chatSecondaryReadsReady?.(state.explicitReadRequested) !== false;
  if (event.action === "restored") {
    state.taskDetailRequests.clear();
    state.taskDetails.clear();
    state.taskDetailErrors.clear();
    state.pendingTaskEvents?.events.clear();
    delete state.deferredRetryAttempt;
  }
  if (event.action === "restored" && !readReady) {
    // Restore replaces the registry snapshot. Retire any older page without
    // issuing hidden work; presentation will start the authoritative reload.
    state.requestId += 1;
    state.pendingTaskEvents = null;
    state.pendingReload = false;
    state.loading = false;
    state.tasks = null;
    state.loadedClient = null;
    state.error = null;
    delete state.errorTaskId;
    host.requestUpdate?.();
    return;
  }
  if (
    event.action === "deleted" &&
    (state.taskDetails.has(event.taskId) ||
      state.taskDetailRequests.has(event.taskId) ||
      state.taskDetailErrors.has(event.taskId) ||
      state.tasks?.some((task) => task.id === event.taskId))
  ) {
    state.taskDetails.delete(event.taskId);
    state.taskDetailRequests.delete(event.taskId);
    state.taskDetailErrors.set(event.taskId, t("chat.backgroundTasks.taskUnavailable"));
    host.requestUpdate?.();
  }
  if (state.tasks === null) {
    // The exact in-flight snapshot already replays its buffered events; a
    // redundant stale reload would immediately undo that initial-load replay.
    if (readReady && !bufferedEvent) {
      loadBackgroundTasks(host, state, true);
    } else if (!bufferedEvent) {
      state.pendingReload = true;
      host.requestUpdate?.();
    }
    return;
  }
  if (event.action === "restored") {
    loadBackgroundTasks(host, state, true);
    return;
  }
  if (event.action === "deleted") {
    if (!state.tasks.some((task) => task.id === event.taskId)) {
      return;
    }
    state.tasks = state.tasks.filter((task) => task.id !== event.taskId);
    state.taskDetails.delete(event.taskId);
    state.taskActivityById.delete(event.taskId);

    host.requestUpdate?.();
    return;
  }
  const current = state.tasks.find((task) => task.id === event.task.id);
  const detail = state.taskDetails.get(event.task.id);
  let newest = current ? newestTaskSnapshot(current, event.task, "event") : event.task;
  newest = newestTaskSnapshot(newest, detail);
  state.tasks = sortTasks([newest, ...state.tasks.filter((task) => task.id !== event.task.id)]);
  if (detail) {
    state.taskDetails = new Map(state.taskDetails).set(event.task.id, {
      ...newest,
      ...(detail.prompt ? { prompt: detail.prompt } : {}),
    });
  }
  host.requestUpdate?.();
}

async function loadBackgroundTaskDetail(
  host: BackgroundTasksHost,
  state: BackgroundTasksState,
  rowId: string,
) {
  const client = host.client;
  if (
    !client ||
    !host.connected ||
    getBackgroundTasksState(host) !== state ||
    state.taskDetails.has(rowId) ||
    state.taskDetailRequests.has(rowId)
  ) {
    return;
  }
  const request = Symbol(rowId);
  state.taskDetailRequests.set(rowId, request);
  const isCurrent = () =>
    getBackgroundTasksState(host) === state && state.taskDetailRequests.get(rowId) === request;
  const nextErrors = new Map(state.taskDetailErrors);
  nextErrors.delete(rowId);
  state.taskDetailErrors = nextErrors;
  host.requestUpdate?.();
  try {
    const payload = await client.request("tasks.get", { taskId: rowId });
    if (!isCurrent()) {
      return;
    }
    const normalizedDetail = normalizeTasksGetResult(payload);
    const detail = normalizedDetail ? prepareTaskSnapshot(state, normalizedDetail) : null;
    if (!detail || detail.id !== rowId) {
      throw new Error(t("chat.backgroundTasks.detailFailed"));
    }
    const current = state.tasks?.find((candidate) => candidate.id === rowId);
    if (!current && taskMatchesSessionScope(host, detail, state) !== "match") {
      throw new Error(t("chat.backgroundTasks.taskUnavailable"));
    }
    const newest = current ? newestTaskSnapshot(current, detail) : detail;
    state.taskDetails = new Map(state.taskDetails).set(rowId, {
      ...newest,
      ...(detail.prompt ? { prompt: detail.prompt } : {}),
    });
    if (current && state.tasks) {
      state.tasks = sortTasks([
        newest,
        ...state.tasks.filter((candidate) => candidate.id !== rowId),
      ]);
    }
  } catch (error) {
    if (isCurrent()) {
      const message = formatUiError(error, t("chat.backgroundTasks.detailFailed"));
      state.taskDetailErrors = new Map(state.taskDetailErrors).set(rowId, message);
    }
  } finally {
    if (isCurrent()) {
      state.taskDetailRequests.delete(rowId);
    }
    host.requestUpdate?.();
  }
}

async function cancelBackgroundTask(
  host: BackgroundTasksHost,
  state: BackgroundTasksState,
  taskId: string,
) {
  const client = host.client;
  if (
    !client ||
    !host.connected ||
    getBackgroundTasksState(host) !== state ||
    state.cancellingTaskIds.has(taskId)
  ) {
    return;
  }
  state.cancellingTaskIds = new Set([...state.cancellingTaskIds, taskId]);
  state.error = null;
  delete state.errorTaskId;
  host.requestUpdate?.();
  try {
    const payload = await client.request("tasks.cancel", { taskId });
    if (getBackgroundTasksState(host) !== state) {
      return;
    }
    const result = normalizeTasksCancelResult(payload);
    if (result?.task && state.tasks !== null) {
      const cancelled = prepareTaskSnapshot(state, result.task);
      // A slow client may miss the best-effort task event; the successful
      // cancel response must still survive its own in-flight list snapshot.
      bufferBackgroundTaskEvent(state, { action: "upserted", task: cancelled });
      state.tasks = sortTasks([
        cancelled,
        ...state.tasks.filter((task) => task.id !== cancelled.id),
      ]);
    }
    // Refusals (already terminal, stale id, no cancellation handle) are
    // successful responses with cancelled=false; surface them like errors.
    if (!result?.cancelled) {
      const reason = result?.reason;
      state.error = reason ? formatUiError(reason) : t("tasksPage.cancelFailed");
      state.errorTaskId = taskId;
    }
  } catch (error) {
    if (getBackgroundTasksState(host) === state) {
      state.error = formatUiError(error, t("tasksPage.cancelFailed"));
      state.errorTaskId = taskId;
    }
  } finally {
    if (getBackgroundTasksState(host) === state) {
      const next = new Set(state.cancellingTaskIds);
      next.delete(taskId);
      state.cancellingTaskIds = next;
    }
    host.requestUpdate?.();
  }
}

export function refreshBackgroundTasks(
  host: BackgroundTasksHost,
  state = getBackgroundTasksState(host),
): void {
  delete state.deferredRetryAttempt;
  state.explicitReadRequested = true;
  loadBackgroundTasks(host, state, true);
}

export function createBackgroundTasksProps(
  host: BackgroundTasksHost,
  opts: {
    narrowLayout?: boolean;
    selectedTaskId?: string;
    onOpenTaskDetail?: (task: TaskSummary) => void;
    onOpenTaskList?: () => void;
    presented?: boolean;
  } = {},
): BackgroundTasksProps {
  const state = getBackgroundTasksState(host);
  if (!host.connected) {
    // A reconnect can silently drop `task` events, so a disconnect invalidates
    // the loaded marker and the next connected render refetches the snapshot.
    state.loadedClient = null;
  }
  // Load eagerly even while collapsed: the toggle badge is how running work
  // gets detected at all, so it cannot wait for the rail to be opened first.
  if (
    opts.presented !== false &&
    host.chatSecondaryReadsReady?.(state.explicitReadRequested) !== false &&
    host.connected &&
    !state.loading &&
    (!state.error || state.pendingReload) &&
    (state.tasks === null || state.loadedClient !== host.client)
  ) {
    loadBackgroundTasks(host, state);
  }
  if (
    opts.presented !== false &&
    opts.selectedTaskId &&
    !state.loading &&
    state.tasks !== null &&
    host.chatSecondaryReadsReady?.(state.explicitReadRequested) !== false &&
    !state.tasks?.some((task) => task.id === opts.selectedTaskId) &&
    !state.taskDetails.has(opts.selectedTaskId) &&
    !state.taskDetailErrors.has(opts.selectedTaskId)
  ) {
    void loadBackgroundTaskDetail(host, state, opts.selectedTaskId);
  }
  const subagentActivity = deriveSubagentActivity({
    tasks: state.tasks ?? [],
    sessionKey: state.sessionKey,
    canonicalizeSessionKey: (sessionKey) =>
      canonicalUiSessionKeyForPersistence(host, sessionKey) ||
      normalizeOptionalString(sessionKey) ||
      "",
  });
  return {
    sessionKey: state.sessionKey,
    statusRowId: state.statusRowId,
    collapsed: state.collapsed,
    narrowLayout: opts.narrowLayout === true,
    connected: host.connected,
    // tasks.cancel needs operator.write; read-only operators get no button.
    canCancel: host.connected && hasOperatorWriteAccess(host.hello?.auth ?? null),
    loading: state.loading,
    error:
      state.errorTaskId && opts.selectedTaskId && state.errorTaskId !== opts.selectedTaskId
        ? null
        : state.error,
    tasks: state.tasks,
    activeCount: state.tasks?.filter(isActiveTask).length ?? 0,
    subagentActivity,
    selectedTaskId: opts.selectedTaskId,
    taskDetails: state.taskDetails,
    taskDetailErrors: state.taskDetailErrors,
    taskDetailLoadingIds: new Set(state.taskDetailRequests.keys()),
    cancellingTaskIds: state.cancellingTaskIds,
    finishedCollapsed: state.finishedCollapsed,
    onToggleCollapsed: () => {
      const current = getBackgroundTasksState(host);
      current.collapsed = !current.collapsed;
      host.requestUpdate?.();
    },
    onToggleFinished: () => {
      state.finishedCollapsed = !state.finishedCollapsed;
      host.requestUpdate?.();
    },
    onRefresh: () => refreshBackgroundTasks(host, state),
    onCancel: (taskId) => void cancelBackgroundTask(host, state, taskId),
    onLoadDetail: (task) => void loadBackgroundTaskDetail(host, state, task.id),
    onOpenTaskList: () => {
      if (getBackgroundTasksState(host) !== state) {
        return;
      }
      resetTaskDetail(host);
      state.collapsed = false;
      opts.onOpenTaskList?.();
      host.requestUpdate?.();
    },
    onOpenTaskDetail: opts.onOpenTaskDetail
      ? (task) => {
          if (getBackgroundTasksState(host) !== state) {
            return;
          }
          if (host.taskDetailState?.taskId !== task.id) {
            resetTaskDetail(host);
          }
          // Opening retries a failed tasks.get: the panel's render-driven load
          // must skip errored tasks (a retry there would loop every paint), so
          // user selection is the one path that clears the error.
          if (state.taskDetailErrors.has(task.id)) {
            const next = new Map(state.taskDetailErrors);
            next.delete(task.id);
            state.taskDetailErrors = next;
          }
          opts.onOpenTaskDetail?.(task);
          host.requestUpdate?.();
        }
      : undefined,
  };
}
