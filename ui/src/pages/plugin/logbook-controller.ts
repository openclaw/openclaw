// Control UI controller for the Logbook tab: state, gateway calls, polling.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import type {
  LogbookDaysPayload,
  LogbookStatusPayload,
  LogbookTimelinePayload,
  LogbookUiState,
} from "./logbook-types.ts";

const FRAME_PREVIEW_CACHE_LIMIT = 48;
const POLL_INTERVAL_MS = 30_000;

type LogbookControllerState = LogbookUiState & {
  // Client identity is the controller epoch. Rebinding retires every async
  // owner so an old gateway cannot mutate or block the replacement view.
  client: GatewayBrowserClient | null;
  clientGeneration: number;
  // Every load advances result ownership; foreground loading state has its own
  // owner so a superseded request cannot clear a newer spinner.
  loadGeneration: number;
  loadingGeneration: number | null;
  backgroundRefresh: Promise<void> | null;
  backgroundRefreshQueued: boolean;
  pollTimer: ReturnType<typeof globalThis.setInterval> | null;
  pollClient: GatewayBrowserClient | null;
};

const logbookStates = new WeakMap<object, LogbookControllerState>();

export function localDayKey(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function shiftDay(day: string, deltaDays: number): string {
  const base = new Date(`${day}T12:00:00`);
  base.setDate(base.getDate() + deltaDays);
  return localDayKey(base);
}

export function getLogbookState(host: object): LogbookControllerState {
  let state = logbookStates.get(host);
  if (!state) {
    state = {
      day: localDayKey(),
      dayPinned: false,
      status: null,
      days: [],
      timeline: null,
      loading: false,
      error: null,
      expandedCardIds: new Set(),
      framePreviews: new Map(),
      frameLoads: new Set(),
      framePreviewFailed: new Set(),
      standup: null,
      standupLoading: false,
      askQuestion: "",
      askAnswer: null,
      askLoading: false,
      actionPending: false,
      client: null,
      clientGeneration: 0,
      loadGeneration: 0,
      loadingGeneration: null,
      backgroundRefresh: null,
      backgroundRefreshQueued: false,
      pollTimer: null,
      pollClient: null,
      requestUpdate: null,
    };
    logbookStates.set(host, state);
  }
  return state;
}

function notify(state: LogbookUiState): void {
  state.requestUpdate?.();
}

function ownsClient(
  state: LogbookControllerState,
  client: GatewayBrowserClient,
  generation: number,
): boolean {
  return state.client === client && state.clientGeneration === generation;
}

function currentClientGeneration(
  state: LogbookControllerState,
  client: GatewayBrowserClient | null,
): number | null {
  return client && state.client === client ? state.clientGeneration : null;
}

function bindClient(state: LogbookControllerState, client: GatewayBrowserClient | null): void {
  if (state.client === client) {
    return;
  }
  state.client = client;
  state.clientGeneration += 1;
  state.loadGeneration += 1;
  state.loadingGeneration = null;
  state.loading = false;
  state.backgroundRefresh = null;
  state.backgroundRefreshQueued = false;
  state.actionPending = false;
  state.standupLoading = false;
  state.askLoading = false;
  state.frameLoads = new Set();
}

function resetDayView(state: LogbookControllerState, day: string): void {
  state.day = day;
  state.timeline = null;
  state.standup = null;
  state.askAnswer = null;
  state.expandedCardIds = new Set();
}

export async function loadLogbook(
  state: LogbookControllerState,
  client: GatewayBrowserClient | null,
  opts?: { day?: string; today?: boolean; silent?: boolean },
): Promise<void> {
  const clientGeneration = currentClientGeneration(state, client);
  if (!client || clientGeneration === null) {
    return;
  }
  if (opts?.day) {
    state.dayPinned = true;
    if (opts.day !== state.day) {
      resetDayView(state, opts.day);
    }
  } else if (opts?.today) {
    state.dayPinned = false;
  }
  const generation = ++state.loadGeneration;
  const requestedDay = state.day;
  if (!opts?.silent) {
    state.loadingGeneration = generation;
    state.loading = true;
    state.error = null;
    notify(state);
  }
  try {
    const [status, days, timeline] = await Promise.all([
      client.request<LogbookStatusPayload>("logbook.status", {}),
      client.request<LogbookDaysPayload>("logbook.days", {}),
      client.request<LogbookTimelinePayload>("logbook.timeline", { day: requestedDay }),
    ]);
    if (
      !ownsClient(state, client, clientGeneration) ||
      generation !== state.loadGeneration ||
      state.day !== requestedDay
    ) {
      return;
    }
    state.status = status;
    state.days = days.days;
    // Unpinned views follow the gateway's day: the browser clock can sit in
    // another timezone than the capture host, and midnight rollover should
    // advance the default view.
    if (!state.dayPinned && status.today !== state.day) {
      resetDayView(state, status.today);
      const todayTimeline = await client.request<LogbookTimelinePayload>("logbook.timeline", {
        day: status.today,
      });
      if (
        !ownsClient(state, client, clientGeneration) ||
        generation !== state.loadGeneration ||
        state.day !== status.today
      ) {
        return;
      }
      state.timeline = todayTimeline;
    } else {
      state.timeline = timeline;
    }
    state.error = null;
  } catch (err) {
    if (ownsClient(state, client, clientGeneration) && generation === state.loadGeneration) {
      state.error = formatUiError(err);
    }
  } finally {
    let shouldNotify =
      ownsClient(state, client, clientGeneration) && generation === state.loadGeneration;
    if (state.loadingGeneration === generation) {
      state.loadingGeneration = null;
      state.loading = false;
      shouldNotify = true;
    }
    if (shouldNotify) {
      notify(state);
    }
    drainQueuedLogbookRefresh(state);
  }
}

function drainQueuedLogbookRefresh(state: LogbookControllerState): void {
  if (!state.backgroundRefreshQueued || state.loading || state.backgroundRefresh) {
    return;
  }
  state.backgroundRefreshQueued = false;
  const client = state.pollClient;
  if (!client) {
    return;
  }
  void refreshLogbookSilently(state, client, { required: true });
}

function refreshLogbookSilently(
  state: LogbookControllerState,
  client: GatewayBrowserClient,
  opts?: { required?: boolean },
): Promise<void> {
  if (state.pollClient !== client) {
    return Promise.resolve();
  }
  if (state.loading || state.backgroundRefresh) {
    if (opts?.required) {
      state.backgroundRefreshQueued = true;
    }
    return state.backgroundRefresh ?? Promise.resolve();
  }
  const refresh = loadLogbook(state, client, { silent: true });
  state.backgroundRefresh = refresh;
  void refresh.finally(() => {
    if (state.backgroundRefresh === refresh) {
      state.backgroundRefresh = null;
    }
    drainQueuedLogbookRefresh(state);
  });
  return refresh;
}

/** Stops background polling; wired into tab-switch and disconnect cleanup. */
export function stopLogbookPolling(host: object): void {
  const state = logbookStates.get(host);
  if (state?.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  if (state) {
    state.pollClient = null;
    state.backgroundRefreshQueued = false;
    // PluginPage retires this host immediately after stop returns. Let its loads
    // settle; host identity keeps their results out of the replacement view.
  }
}

export function configureLogbookPolling(
  state: LogbookControllerState,
  client: GatewayBrowserClient | null,
  active: boolean,
): void {
  if (!active || !client) {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    state.pollClient = null;
    state.backgroundRefreshQueued = false;
    // Unlike stopLogbookPolling's detached-host path, this state can render
    // again after reconnect. Retire every old async owner before reuse.
    bindClient(state, null);
    return;
  }
  if (state.pollTimer && state.pollClient === client) {
    return;
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
  }
  bindClient(state, client);
  state.pollClient = client;
  state.pollTimer = setInterval(() => {
    // All background refresh sources share one owner so slow gateway responses
    // cannot stack another status/days/timeline batch on every interval.
    void refreshLogbookSilently(state, client);
  }, POLL_INTERVAL_MS);
}

export async function loadLogbookFramePreview(
  state: LogbookControllerState,
  client: GatewayBrowserClient | null,
  frameId: number,
): Promise<void> {
  const clientGeneration = currentClientGeneration(state, client);
  if (
    !client ||
    clientGeneration === null ||
    state.framePreviews.has(frameId) ||
    state.frameLoads.has(frameId) ||
    state.framePreviewFailed.has(frameId)
  ) {
    return;
  }
  state.frameLoads.add(frameId);
  try {
    const payload = await client.request<{ base64: string; format: string }>("logbook.frame", {
      frameId,
    });
    if (!ownsClient(state, client, clientGeneration)) {
      return;
    }
    if (state.framePreviews.size >= FRAME_PREVIEW_CACHE_LIMIT) {
      const oldest = state.framePreviews.keys().next().value;
      if (oldest !== undefined) {
        state.framePreviews.delete(oldest);
      }
    }
    state.framePreviews.set(frameId, `data:image/${payload.format};base64,${payload.base64}`);
  } catch {
    // Preview loads are cosmetic, but a missing frame (e.g. pruned by
    // retention) must not re-fetch on every render, so remember the failure.
    if (ownsClient(state, client, clientGeneration)) {
      state.framePreviewFailed.add(frameId);
    }
  } finally {
    if (ownsClient(state, client, clientGeneration)) {
      state.frameLoads.delete(frameId);
      notify(state);
    }
  }
}

async function runLogbookAction(
  state: LogbookControllerState,
  client: GatewayBrowserClient | null,
  pending: "actionPending" | "standupLoading" | "askLoading",
  run: (client: GatewayBrowserClient, isCurrent: () => boolean) => Promise<void>,
  settled?: (client: GatewayBrowserClient) => void,
): Promise<void> {
  const clientGeneration = currentClientGeneration(state, client);
  if (!client || clientGeneration === null || state[pending]) {
    return;
  }
  const isCurrent = () => ownsClient(state, client, clientGeneration);
  state[pending] = true;
  try {
    await run(client, isCurrent);
  } catch (err) {
    if (isCurrent()) {
      state.error = formatUiError(err);
    }
  } finally {
    if (isCurrent()) {
      state[pending] = false;
      notify(state);
      settled?.(client);
    }
  }
}

export function setLogbookCapturePaused(
  state: LogbookControllerState,
  client: GatewayBrowserClient | null,
  paused: boolean,
): Promise<void> {
  return runLogbookAction(state, client, "actionPending", async (current, isCurrent) => {
    notify(state);
    const status = await current.request<LogbookStatusPayload>("logbook.capture.set", { paused });
    if (isCurrent()) {
      state.status = status;
    }
  });
}

export function runLogbookAnalysisNow(
  state: LogbookControllerState,
  client: GatewayBrowserClient | null,
): Promise<void> {
  return runLogbookAction(
    state,
    client,
    "actionPending",
    async (current, isCurrent) => {
      notify(state);
      const result = await current.request<{ started: boolean; reason?: string }>(
        "logbook.analyze.now",
        {},
      );
      if (isCurrent() && !result.started && result.reason) {
        state.error = formatUiExternalText(result.reason);
      }
    },
    (current) => void refreshLogbookSilently(state, current, { required: true }),
  );
}

export function loadLogbookStandup(
  state: LogbookControllerState,
  client: GatewayBrowserClient | null,
  refresh: boolean,
): Promise<void> {
  return runLogbookAction(state, client, "standupLoading", async (current, isCurrent) => {
    notify(state);
    const requestedDay = state.day;
    const standup = await current.request<{ day: string; text: string; updatedMs: number }>(
      "logbook.standup",
      { day: requestedDay, refresh },
    );
    if (isCurrent() && state.day === requestedDay) {
      state.standup = standup;
    }
  });
}

export async function askLogbook(
  state: LogbookControllerState,
  client: GatewayBrowserClient | null,
): Promise<void> {
  const question = state.askQuestion.trim();
  if (!question) {
    return;
  }
  return runLogbookAction(state, client, "askLoading", async (current, isCurrent) => {
    state.askAnswer = null;
    notify(state);
    const requestedDay = state.day;
    const payload = await current.request<{ answer: string }>("logbook.ask", {
      day: requestedDay,
      question,
    });
    if (isCurrent() && state.day === requestedDay) {
      state.askAnswer = payload.answer;
    }
  });
}
