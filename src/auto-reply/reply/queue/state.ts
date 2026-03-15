import { resolveGlobalMap } from "../../../shared/global-singleton.js";
import { applyQueueRuntimeSettings } from "../../../utils/queue-helpers.js";
import { globalQueuePositionTracker } from "./position-tracker.js";
import type { FollowupRun, QueueDropPolicy, QueueMode, QueueSettings } from "./types.js";

export type FollowupQueueState = {
  items: FollowupRun[];
  draining: boolean;
  lastEnqueuedAt: number;
  mode: QueueMode;
  debounceMs: number;
  cap: number;
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
  lastRun?: FollowupRun["run"];
};

export const DEFAULT_QUEUE_DEBOUNCE_MS = 1000;
export const DEFAULT_QUEUE_CAP = 20;
export const DEFAULT_QUEUE_DROP: QueueDropPolicy = "summarize";

/**
 * Share followup queues across bundled chunks so busy-session enqueue/drain
 * logic observes one queue registry per process.
 */
const FOLLOWUP_QUEUES_KEY = Symbol.for("openclaw.followupQueues");

export const FOLLOWUP_QUEUES = resolveGlobalMap<string, FollowupQueueState>(FOLLOWUP_QUEUES_KEY);

export function getExistingFollowupQueue(key: string): FollowupQueueState | undefined {
  const cleaned = key.trim();
  if (!cleaned) {
    return undefined;
  }
  return FOLLOWUP_QUEUES.get(cleaned);
}

export function getFollowupQueue(key: string, settings: QueueSettings): FollowupQueueState {
  const existing = FOLLOWUP_QUEUES.get(key);
  if (existing) {
    applyQueueRuntimeSettings({
      target: existing,
      settings,
    });
    return existing;
  }

  const created: FollowupQueueState = {
    items: [],
    draining: false,
    lastEnqueuedAt: 0,
    mode: settings.mode,
    debounceMs:
      typeof settings.debounceMs === "number"
        ? Math.max(0, settings.debounceMs)
        : DEFAULT_QUEUE_DEBOUNCE_MS,
    cap:
      typeof settings.cap === "number" && settings.cap > 0
        ? Math.floor(settings.cap)
        : DEFAULT_QUEUE_CAP,
    dropPolicy: settings.dropPolicy ?? DEFAULT_QUEUE_DROP,
    droppedCount: 0,
    summaryLines: [],
  };
  applyQueueRuntimeSettings({
    target: created,
    settings,
  });
  FOLLOWUP_QUEUES.set(key, created);
  return created;
}

export function clearFollowupQueue(key: string): number {
  const cleaned = key.trim();
  const queue = getExistingFollowupQueue(cleaned);
  if (!queue) {
    return 0;
  }
  const cleared = queue.items.length + queue.droppedCount;
  // Clear position reactions only for items in this queue, not globally.
  void globalQueuePositionTracker.clearQueuePositions(queue.items);
  queue.items.length = 0;
  queue.droppedCount = 0;
  queue.summaryLines = [];
  queue.lastRun = undefined;
  queue.lastEnqueuedAt = 0;
  FOLLOWUP_QUEUES.delete(cleaned);
  return cleared;
}
