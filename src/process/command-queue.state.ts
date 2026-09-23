// Shared command-queue runtime state, split out of command-queue.ts so the
// capacity-group policy can read lane state without importing the queue itself.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { CommandQueueEnqueueOptions } from "./command-queue.types.js";
import { CommandLane } from "./lanes.js";

export type CommandLaneTaskMarker = Readonly<{
  lane: string;
  taskId: number;
  generation: number;
}>;

export type QueuePriority = -1 | 0 | 1;

export type QueueEntry = {
  queued?: true;
  previous?: QueueEntry;
  next?: QueueEntry;
  task: (marker: CommandLaneTaskMarker) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  sequence: number;
  priority: QueuePriority;
  warnAfterMs: number;
  queuedAheadAtEnqueue: number;
  activeAheadAtEnqueue: number;
  taskTimeoutMs?: number;
  taskTimeoutProgressAtMs?: () => number | undefined;
  taskTimeoutSubscribe?: CommandQueueEnqueueOptions["taskTimeoutSubscribe"];
  taskTimeoutAbortSignal?: AbortSignal;
  taskTimeoutAbortGraceMs?: number;
  taskTimeoutReleaseSignal?: AbortSignal;
  onWait?: (waitMs: number, queuedAhead: number) => void;
  releaseQueuedAbort?: () => void;
};

type QueueFifo = {
  head: QueueEntry | undefined;
  tail: QueueEntry | undefined;
  length: number;
};

/** Three fixed FIFO lists, one for each supported priority. */
type LaneQueue = {
  background: QueueFifo;
  normal: QueueFifo;
  foreground: QueueFifo;
  length: number;
};

export type LaneState = {
  lane: string;
  queue: LaneQueue;
  activeTaskIds: Set<number>;
  maxConcurrent: number;
  draining: boolean;
  generation: number;
};

export type LaneGroupState = {
  group: string;
  budget: number;
  members: Set<string>;
  reservations: Map<string, number>;
};

function createQueueFifo(): QueueFifo {
  return { head: undefined, tail: undefined, length: 0 };
}

export function createLaneQueue(): LaneQueue {
  return {
    background: createQueueFifo(),
    normal: createQueueFifo(),
    foreground: createQueueFifo(),
    length: 0,
  };
}

function getPriorityFifo(queue: LaneQueue, priority: QueuePriority): QueueFifo {
  switch (priority) {
    case 1:
      return queue.foreground;
    case -1:
      return queue.background;
    default:
      return queue.normal;
  }
}

/** Append to one of three fixed priority FIFOs and return the queued work ahead. */
export function enqueueLaneQueue(queue: LaneQueue, entry: QueueEntry): number {
  const fifo = getPriorityFifo(queue, entry.priority);
  const queuedAhead =
    fifo.length +
    (entry.priority <= 0 ? queue.foreground.length : 0) +
    (entry.priority < 0 ? queue.normal.length : 0);
  entry.queued = true;
  entry.previous = fifo.tail;
  entry.next = undefined;
  if (fifo.tail) {
    fifo.tail.next = entry;
  } else {
    fifo.head = entry;
  }
  fifo.tail = entry;
  fifo.length += 1;
  queue.length += 1;
  return queuedAhead;
}

export function peekLaneQueue(queue: LaneQueue): QueueEntry | undefined {
  return queue.foreground.head ?? queue.normal.head ?? queue.background.head;
}

export function dequeueLaneQueue(queue: LaneQueue): QueueEntry | undefined {
  const entry = peekLaneQueue(queue);
  if (entry) {
    removeLaneQueueEntry(queue, entry);
  }
  return entry;
}

/** Unlink without scanning successors, including when one abort cancels an entire backlog. */
export function removeLaneQueueEntry(queue: LaneQueue, entry: QueueEntry): boolean {
  if (!entry.queued) {
    return false;
  }
  const fifo = getPriorityFifo(queue, entry.priority);
  if (entry.previous) {
    entry.previous.next = entry.next;
  } else {
    fifo.head = entry.next;
  }
  if (entry.next) {
    entry.next.previous = entry.previous;
  } else {
    fifo.tail = entry.previous;
  }
  entry.queued = undefined;
  fifo.length -= 1;
  queue.length -= 1;
  // A completed entry must not retain its neighbours or expose stale membership
  // if listener cleanup reenters the queue.
  const releaseQueuedAbort = entry.releaseQueuedAbort;
  entry.previous = undefined;
  entry.next = undefined;
  entry.releaseQueuedAbort = undefined;
  releaseQueuedAbort?.();
  return true;
}

/**
 * Keep queue runtime state on globalThis so every bundled entry/chunk shares
 * the same lanes, counters, and draining flag in production builds.
 */
const COMMAND_QUEUE_STATE_KEY = Symbol.for("openclaw.commandQueueState");

export function getQueueState() {
  return resolveGlobalSingleton(COMMAND_QUEUE_STATE_KEY, () => ({
    lanes: new Map<string, LaneState>(),
    nextTaskId: 1,
    nextQueueSequence: 1,
    laneGroups: new Map<string, LaneGroupState>(),
    laneGroupByLane: new Map<string, string>(),
  }));
}

export function normalizeLane(lane: string): string {
  return lane.trim() || CommandLane.Main;
}
