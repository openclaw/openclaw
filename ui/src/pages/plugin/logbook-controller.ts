// Control UI controller for the Logbook tab: state, gateway calls, polling.
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type LogbookStatusPayload = {
  captureEnabled: boolean;
  capturePaused: boolean;
  captureIntervalSeconds: number;
  analysisIntervalMinutes: number;
  retentionDays: number;
  nodeId?: string;
  nodeName?: string;
  lastCaptureAtMs?: number;
  lastCaptureError?: string;
  pendingFrames: number;
  analysisRunning: boolean;
  lastBatch?: { id: number; day: string; status: string; endMs: number; error?: string };
  visionModel?: string;
  visionModelSource: "config" | "media-defaults" | "missing";
  today: string;
  todayCards: number;
  timeZone: string;
};

type LogbookDistractionPayload = { startMs: number; endMs: number; title: string };

export type LogbookCardPayload = {
  id: number;
  day: string;
  startMs: number;
  endMs: number;
  title: string;
  summary: string;
  detail: string;
  category: string;
  appPrimary?: string;
  appSecondary?: string;
  distractions: LogbookDistractionPayload[];
  keyframeId?: number;
};

type LogbookDayStatsPayload = {
  trackedMs: number;
  distractionMs: number;
  categories: Array<{ category: string; ms: number }>;
  apps: Array<{ domain: string; ms: number }>;
};

type LogbookTimelinePayload = {
  day: string;
  cards: LogbookCardPayload[];
  stats: LogbookDayStatsPayload;
};

type LogbookDaysPayload = {
  days: Array<{ day: string; cards: number; firstMs: number; lastMs: number }>;
};

type LogbookBackgroundRefresh = {
  client: GatewayBrowserClient;
  lifecycleGeneration: number;
};

export type LogbookUiState = {
  day: string;
  /** True once the user navigated to a specific day; unpinned views follow the gateway's today. */
  dayPinned: boolean;
  status: LogbookStatusPayload | null;
  days: LogbookDaysPayload["days"];
  timeline: LogbookTimelinePayload | null;
  loading: boolean;
  error: string | null;
  expandedCardIds: Set<number>;
  framePreviews: Map<number, string>;
  frameLoads: Set<number>;
  framePreviewFailed: Set<number>;
  standup: { day: string; text: string; updatedMs: number } | null;
  standupLoading: boolean;
  askQuestion: string;
  askAnswer: string | null;
  askLoading: boolean;
  actionPending: boolean;
  // Every load advances result ownership; foreground loading state has its own
  // owner so a superseded request cannot clear a newer spinner.
  loadGeneration: number;
  loadingGeneration: number | null;
  lifecycleGeneration: number;
  backgroundRefresh: Promise<void> | null;
  backgroundRefreshQueued: LogbookBackgroundRefresh | null;
  pollTimer: ReturnType<typeof globalThis.setInterval> | null;
  pollClient: GatewayBrowserClient | null;
  requestUpdate: (() => void) | null;
};

const FRAME_PREVIEW_CACHE_LIMIT = 48;
const POLL_INTERVAL_MS = 30_000;

const logbookStates = new WeakMap<object, LogbookUiState>();

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

export function getLogbookState(host: object): LogbookUiState {
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
      loadGeneration: 0,
      loadingGeneration: null,
      lifecycleGeneration: 0,
      backgroundRefresh: null,
      backgroundRefreshQueued: null,
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

function resetDayView(state: LogbookUiState, day: string): void {
  state.day = day;
  state.timeline = null;
  state.standup = null;
  state.askAnswer = null;
  state.expandedCardIds = new Set();
}

export async function loadLogbook(
  state: LogbookUiState,
  client: GatewayBrowserClient | null,
  opts?: { day?: string; today?: boolean; silent?: boolean },
): Promise<void> {
  if (!client) {
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
    if (generation !== state.loadGeneration || state.day !== requestedDay) {
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
      if (generation !== state.loadGeneration || state.day !== status.today) {
        return;
      }
      state.timeline = todayTimeline;
    } else {
      state.timeline = timeline;
    }
    state.error = null;
  } catch (err) {
    if (generation === state.loadGeneration) {
      state.error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    let shouldNotify = generation === state.loadGeneration;
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

function retireLogbookLoads(state: LogbookUiState): void {
  // A stopped or rebound view must not accept results from its retired client,
  // and an abandoned background request must not block the next polling epoch.
  state.loadGeneration += 1;
  state.lifecycleGeneration += 1;
  state.loadingGeneration = null;
  state.loading = false;
  state.backgroundRefresh = null;
  state.backgroundRefreshQueued = null;
}

function isLogbookRefreshCurrent(
  state: LogbookUiState,
  refresh: LogbookBackgroundRefresh,
): boolean {
  return (
    refresh.lifecycleGeneration === state.lifecycleGeneration &&
    (state.pollClient === null || state.pollClient === refresh.client)
  );
}

function drainQueuedLogbookRefresh(state: LogbookUiState): void {
  if (state.loading || state.backgroundRefresh) {
    return;
  }
  const queued = state.backgroundRefreshQueued;
  state.backgroundRefreshQueued = null;
  if (!queued || !isLogbookRefreshCurrent(state, queued)) {
    return;
  }
  void refreshLogbookSilently(state, queued.client, {
    lifecycleGeneration: queued.lifecycleGeneration,
    required: true,
  });
}

function refreshLogbookSilently(
  state: LogbookUiState,
  client: GatewayBrowserClient,
  opts?: { lifecycleGeneration?: number; required?: boolean },
): Promise<void> {
  const refreshRequest = {
    client,
    lifecycleGeneration: opts?.lifecycleGeneration ?? state.lifecycleGeneration,
  };
  if (!isLogbookRefreshCurrent(state, refreshRequest)) {
    return Promise.resolve();
  }
  if (state.loading || state.backgroundRefresh) {
    if (opts?.required) {
      state.backgroundRefreshQueued = refreshRequest;
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
    retireLogbookLoads(state);
  }
}

export function configureLogbookPolling(
  state: LogbookUiState,
  client: GatewayBrowserClient | null,
  active: boolean,
): void {
  if (!active || !client) {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    state.pollClient = null;
    retireLogbookLoads(state);
    return;
  }
  if (state.pollTimer && state.pollClient === client) {
    return;
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
  }
  retireLogbookLoads(state);
  state.pollClient = client;
  state.pollTimer = setInterval(() => {
    // All background refresh sources share one owner so slow gateway responses
    // cannot stack another status/days/timeline batch on every interval.
    void refreshLogbookSilently(state, client);
  }, POLL_INTERVAL_MS);
}

export async function loadLogbookFramePreview(
  state: LogbookUiState,
  client: GatewayBrowserClient | null,
  frameId: number,
): Promise<void> {
  if (
    !client ||
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
    state.framePreviewFailed.add(frameId);
  } finally {
    state.frameLoads.delete(frameId);
    notify(state);
  }
}

export async function setLogbookCapturePaused(
  state: LogbookUiState,
  client: GatewayBrowserClient | null,
  paused: boolean,
): Promise<void> {
  if (!client || state.actionPending) {
    return;
  }
  state.actionPending = true;
  notify(state);
  try {
    state.status = await client.request<LogbookStatusPayload>("logbook.capture.set", { paused });
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.actionPending = false;
    notify(state);
  }
}

export async function runLogbookAnalysisNow(
  state: LogbookUiState,
  client: GatewayBrowserClient | null,
): Promise<void> {
  if (!client || state.actionPending) {
    return;
  }
  state.actionPending = true;
  notify(state);
  const lifecycleGeneration = state.lifecycleGeneration;
  try {
    const result = await client.request<{ started: boolean; reason?: string }>(
      "logbook.analyze.now",
      {},
    );
    if (!result.started && result.reason) {
      state.error = result.reason;
    }
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.actionPending = false;
    notify(state);
    void refreshLogbookSilently(state, client, { lifecycleGeneration, required: true });
  }
}

export async function loadLogbookStandup(
  state: LogbookUiState,
  client: GatewayBrowserClient | null,
  refresh: boolean,
): Promise<void> {
  if (!client || state.standupLoading) {
    return;
  }
  state.standupLoading = true;
  notify(state);
  const requestedDay = state.day;
  try {
    const standup = await client.request<{ day: string; text: string; updatedMs: number }>(
      "logbook.standup",
      { day: requestedDay, refresh },
    );
    if (state.day === requestedDay) {
      state.standup = standup;
    }
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.standupLoading = false;
    notify(state);
  }
}

export async function askLogbook(
  state: LogbookUiState,
  client: GatewayBrowserClient | null,
): Promise<void> {
  const question = state.askQuestion.trim();
  if (!client || state.askLoading || question.length === 0) {
    return;
  }
  state.askLoading = true;
  state.askAnswer = null;
  notify(state);
  const requestedDay = state.day;
  try {
    const payload = await client.request<{ answer: string }>("logbook.ask", {
      day: requestedDay,
      question,
    });
    if (state.day === requestedDay) {
      state.askAnswer = payload.answer;
    }
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.askLoading = false;
    notify(state);
  }
}
