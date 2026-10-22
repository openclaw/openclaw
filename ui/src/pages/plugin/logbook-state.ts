import { onCleanup } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { projectMutableSource } from "../../lib/reactive/projection.ts";
import type {
  LogbookStatusPayload,
  LogbookTimelinePayload,
  LogbookUiState,
} from "./logbook-types.ts";

const FRAME_PREVIEW_CACHE_LIMIT = 48;
const POLL_INTERVAL_MS = 30_000;

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

export function createLogbook(initialClient: GatewayBrowserClient | null) {
  // Request admission and selected-day custody must change before the next Solid flush.
  const state: LogbookUiState = {
    day: localDayKey(),
    status: null,
    timeline: null,
    loading: false,
    error: null,
    framePreviews: new Map(),
    framePreviewFailed: new Set(),
    standup: null,
    standupLoading: false,
    askAnswer: null,
    askLoading: false,
    actionPending: false,
  };
  let client = initialClient;
  let dayPinned = false;
  let backgroundRefresh: Promise<void> | null = null;
  let backgroundRefreshQueued = false;
  let dayLifetime = Promise.withResolvers<void>();
  const frameLoads = new Set<number>();
  let notify = () => {};
  const projection = projectMutableSource(state, (source) => source);
  notify = projection.publish;
  onCleanup(() => {
    dayLifetime.resolve();
    clearInterval(pollTimer);
    client = null;
    backgroundRefreshQueued = false;
  });

  function resetDay(day: string) {
    dayLifetime.resolve();
    dayLifetime = Promise.withResolvers<void>();
    state.day = day;
    state.timeline = null;
    state.standup = null;
    state.askAnswer = null;
  }

  async function load(opts?: { day?: string; today?: boolean; silent?: boolean }) {
    const current = client;
    if (!current) {
      return;
    }
    if (opts?.day) {
      dayPinned = true;
      if (opts.day !== state.day) {
        resetDay(opts.day);
      }
    } else if (opts?.today) {
      dayPinned = false;
    }
    const requestedDay = state.day;
    if (!opts?.silent) {
      state.loading = true;
      state.error = null;
      notify();
    }
    try {
      const [status, timeline] = await Promise.all([
        current.request<LogbookStatusPayload>("logbook.status", {}),
        current.request<LogbookTimelinePayload>("logbook.timeline", { day: requestedDay }),
      ]);
      if (client !== current || state.day !== requestedDay) {
        return;
      }
      state.status = status;
      // Follow the capture host's day until the user explicitly selects one.
      if (!dayPinned && status.today !== state.day) {
        resetDay(status.today);
        const todayTimeline = await current.request<LogbookTimelinePayload>("logbook.timeline", {
          day: status.today,
        });
        if (client !== current || state.day !== status.today) {
          return;
        }
        state.timeline = todayTimeline;
      } else {
        state.timeline = timeline;
      }
      state.error = null;
    } catch (error) {
      if (client === current) {
        state.error = formatUiError(error);
      }
    } finally {
      if (client === current) {
        state.loading = false;
        notify();
        drainRefresh();
      }
    }
  }

  function drainRefresh() {
    if (!backgroundRefreshQueued || state.loading || backgroundRefresh) {
      return;
    }
    backgroundRefreshQueued = false;
    void refreshSilently(true);
  }

  function refreshSilently(required = false): Promise<void> {
    if (!client) {
      return Promise.resolve();
    }
    if (state.loading || backgroundRefresh) {
      backgroundRefreshQueued ||= required;
      return backgroundRefresh ?? Promise.resolve();
    }
    const refresh = load({ silent: true });
    backgroundRefresh = refresh;
    void refresh.finally(() => {
      backgroundRefresh = null;
      drainRefresh();
    });
    return refresh;
  }

  function runAction(
    pending: "actionPending" | "standupLoading" | "askLoading",
    run: (current: GatewayBrowserClient, isCurrent: () => boolean) => Promise<void>,
    settled?: () => void,
  ) {
    const current = client;
    if (!current || state[pending]) {
      return undefined;
    }
    const isCurrent = () => client === current;
    state[pending] = true;
    notify();
    return (async () => {
      try {
        await run(current, isCurrent);
      } catch (error) {
        if (isCurrent()) {
          state.error = formatUiError(error);
        }
      } finally {
        if (isCurrent()) {
          state[pending] = false;
          notify();
          settled?.();
        }
      }
    })();
  }

  // PluginPage remounts this model for each connection; polling shares the analysis refresh owner.
  const pollTimer = client
    ? setInterval(() => void refreshSilently(), POLL_INTERVAL_MS)
    : undefined;
  return {
    get dayRetired() {
      return dayLifetime.promise;
    },
    reportError(error: unknown) {
      state.error = formatUiError(error);
      notify();
    },
    get state() {
      return projection.read();
    },
    load,
    async loadFrame(frameId: number) {
      const current = client;
      if (
        !current ||
        state.framePreviews.has(frameId) ||
        frameLoads.has(frameId) ||
        state.framePreviewFailed.has(frameId)
      ) {
        return;
      }
      frameLoads.add(frameId);
      try {
        const payload = await current.request<{ base64: string; format: string }>("logbook.frame", {
          frameId,
        });
        if (client !== current) {
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
        // Missing or pruned frames must not re-fetch on every render.
        if (client === current) {
          state.framePreviewFailed.add(frameId);
        }
      } finally {
        if (client === current) {
          frameLoads.delete(frameId);
          notify();
        }
      }
    },
    setCapturePaused(paused: boolean) {
      return runAction("actionPending", async (current, isCurrent) => {
        const status = await current.request<LogbookStatusPayload>("logbook.capture.set", {
          paused,
        });
        if (isCurrent()) {
          state.status = status;
        }
      });
    },
    analyze() {
      return runAction(
        "actionPending",
        async (current, isCurrent) => {
          const result = await current.request<{ started: boolean; reason?: string }>(
            "logbook.analyze.now",
            {},
          );
          if (isCurrent() && !result.started && result.reason) {
            state.error = formatUiExternalText(result.reason);
          }
        },
        () => void refreshSilently(true),
      );
    },
    standup(refresh: boolean) {
      return runAction("standupLoading", async (current, isCurrent) => {
        const requestedDay = state.day;
        const standup = await current.request<{ day: string; text: string; updatedMs: number }>(
          "logbook.standup",
          { day: requestedDay, refresh },
        );
        if (isCurrent() && state.day === requestedDay) {
          state.standup = standup;
        }
      });
    },
    ask(input: string) {
      const question = input.trim();
      if (!question) {
        return undefined;
      }
      return runAction("askLoading", async (current, isCurrent) => {
        state.askAnswer = null;
        const requestedDay = state.day;
        const payload = await current.request<{ answer: string }>("logbook.ask", {
          day: requestedDay,
          question,
        });
        if (isCurrent() && state.day === requestedDay) {
          state.askAnswer = payload.answer;
        }
      });
    },
  };
}

export type LogbookModel = ReturnType<typeof createLogbook>;
