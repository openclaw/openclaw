import type { EventLogEntry } from "../../api/event-log.ts";
import type { RenderLifecycle } from "./render-lifecycle.ts";

type ChatPerformanceHost = {
  eventLogBuffer?: unknown[];
  renderLifecycle?: RenderLifecycle;
};

const EVENT_LOG_LIMIT = 250;

export function controlUiNowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function roundedControlUiDurationMs(durationMs: number): number {
  return Math.max(0, Math.round(durationMs));
}

function runAfterPaint(callback: () => void, complete: () => void): () => void {
  let active = true;
  let frame: number | null = null;
  const run = () => {
    if (!active) {
      return;
    }
    active = false;
    try {
      callback();
    } finally {
      complete();
    }
  };
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    queueMicrotask(run);
  } else {
    frame = window.requestAnimationFrame(() => {
      frame = null;
      if (!active) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = null;
        run();
      });
    });
  }
  return () => {
    if (!active) {
      return;
    }
    active = false;
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      frame = null;
    }
  };
}

export function recordControlUiPerformanceEvent(
  host: ChatPerformanceHost,
  event: string,
  payload: Record<string, unknown>,
  opts: { warn?: boolean; maxBufferedEventsForType: number },
): void {
  const newEntry: EventLogEntry = { ts: Date.now(), event, payload };
  if (host.eventLogBuffer) {
    let keptForType = 0;
    const existingBuffer = host.eventLogBuffer.filter((entry) => {
      if (!entry || typeof entry !== "object" || !("event" in entry) || entry.event !== event) {
        return true;
      }
      keptForType += 1;
      return keptForType < opts.maxBufferedEventsForType;
    });
    host.eventLogBuffer = [newEntry, ...existingBuffer].slice(0, EVENT_LOG_LIMIT);
  }
  if (opts.warn) {
    console.warn(`[openclaw] ${event}`, payload);
  }
}

export function scheduleControlUiAfterPaint(
  host: Pick<ChatPerformanceHost, "renderLifecycle">,
  callback: () => void,
): void {
  if (host.renderLifecycle) {
    host.renderLifecycle.afterCommit((complete) => runAfterPaint(callback, complete));
    return;
  }
  // Renderer-free unit hosts have no DOM commit to await.
  runAfterPaint(callback, () => undefined);
}
