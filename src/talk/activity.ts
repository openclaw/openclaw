import { randomUUID } from "node:crypto";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { TalkEvent, TalkEventType } from "./talk-events.js";

export type TalkActivityState = "idle" | "listening" | "thinking" | "speaking" | "error";

type TalkActivityEventBase = {
  activityId: string;
  timestamp: string;
};

export type TalkActivityEvent = TalkActivityEventBase &
  (
    | { type: "started" }
    | { type: "state"; state: TalkActivityState }
    | { type: "speech" }
    | { type: "ended" }
  );

export type TalkActivityListener = (event: TalkActivityEvent) => void | Promise<void>;

type Activity = {
  id: string;
  state: TalkActivityState;
};

type Watcher = {
  listener: TalkActivityListener;
  queue: TalkActivityEvent[];
  draining: boolean;
  closed: boolean;
};

type TalkActivityStateStore = {
  activities: Map<string, Activity>;
  watchers: Set<Watcher>;
};

const MAX_PENDING_EVENTS = 128;
const processState = resolveGlobalSingleton<TalkActivityStateStore>(
  Symbol.for("openclaw.talkActivity"),
  () => ({ activities: new Map(), watchers: new Set() }),
);

function scheduleDrain(watcher: Watcher): void {
  if (watcher.draining || watcher.closed) {
    return;
  }
  watcher.draining = true;
  queueMicrotask(() => {
    void drainWatcher(watcher);
  });
}

async function drainWatcher(watcher: Watcher): Promise<void> {
  try {
    while (!watcher.closed) {
      const event = watcher.queue.shift();
      if (!event) {
        return;
      }
      try {
        await watcher.listener(event);
      } catch {
        // A plugin watcher must not interrupt Talk delivery.
      }
    }
  } finally {
    watcher.draining = false;
    if (!watcher.closed && watcher.queue.length > 0) {
      scheduleDrain(watcher);
    }
  }
}

function enqueue(watcher: Watcher, event: TalkActivityEvent): void {
  if (watcher.closed) {
    return;
  }
  if (watcher.queue.length >= MAX_PENDING_EVENTS) {
    const speechIndex = watcher.queue.findIndex((queued) => queued.type === "speech");
    if (speechIndex >= 0) {
      watcher.queue.splice(speechIndex, 1);
    } else if (event.type === "speech") {
      return;
    } else {
      watcher.queue.shift();
    }
  }
  watcher.queue.push(event);
  scheduleDrain(watcher);
}

function publish(event: TalkActivityEvent): void {
  for (const watcher of processState.watchers) {
    enqueue(watcher, event);
  }
}

function stateForEvent(type: TalkEventType): TalkActivityState | undefined {
  switch (type) {
    case "session.started":
      return "idle";
    case "session.ready":
    case "capture.started":
    case "capture.cancelled":
    case "turn.started":
    case "turn.ended":
    case "turn.cancelled":
    case "output.audio.done":
      return "listening";
    case "capture.stopped":
    case "input.audio.committed":
    case "transcript.done":
    case "tool.call":
    case "tool.progress":
    case "tool.result":
      return "thinking";
    case "output.audio.started":
      return "speaking";
    case "session.error":
    case "tool.error":
      return "error";
    default:
      return undefined;
  }
}

function isTerminalEvent(type: TalkEventType): boolean {
  return type === "session.closed" || type === "session.replaced";
}

export function watchTalkActivity(listener: TalkActivityListener): () => void {
  const watcher: Watcher = { listener, queue: [], draining: false, closed: false };
  processState.watchers.add(watcher);
  return () => {
    watcher.closed = true;
    watcher.queue.length = 0;
    processState.watchers.delete(watcher);
    if (processState.watchers.size === 0) {
      processState.activities.clear();
    }
  };
}

export function recordTalkActivityEvent(event: TalkEvent): void {
  if (processState.watchers.size === 0) {
    return;
  }

  let activity = processState.activities.get(event.sessionId);
  if (!activity) {
    activity = { id: randomUUID(), state: "idle" };
    processState.activities.set(event.sessionId, activity);
    publish({ type: "started", activityId: activity.id, timestamp: event.timestamp });
  }

  if (event.type === "output.audio.delta") {
    publish({ type: "speech", activityId: activity.id, timestamp: event.timestamp });
  }

  const nextState = stateForEvent(event.type);
  if (nextState && nextState !== activity.state) {
    activity.state = nextState;
    publish({
      type: "state",
      activityId: activity.id,
      timestamp: event.timestamp,
      state: nextState,
    });
  }

  if (isTerminalEvent(event.type)) {
    publish({ type: "ended", activityId: activity.id, timestamp: event.timestamp });
    processState.activities.delete(event.sessionId);
  }
}
