import { resolveGlobalMap } from "../../../shared/global-singleton.js";
import { applyQueueRuntimeSettings } from "../../../utils/queue-helpers.js";
import type { FollowupRun, QueueDropPolicy, QueueMode, QueueSettings } from "./types.js";

export type FollowupQueueState = {
  items: FollowupRun[];
  draining: boolean;
  paused: boolean;
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
const PAUSED_FOLLOWUP_QUEUE_KEYS = Symbol.for("openclaw.pausedFollowupQueueKeys");

export const FOLLOWUP_QUEUES = resolveGlobalMap<string, FollowupQueueState>(FOLLOWUP_QUEUES_KEY);
const FOLLOWUP_QUEUE_PAUSES = resolveGlobalMap<string, true>(PAUSED_FOLLOWUP_QUEUE_KEYS);

export function getExistingFollowupQueue(key: string): FollowupQueueState | undefined {
  const cleaned = key.trim();
  if (!cleaned) {
    return undefined;
  }
  return FOLLOWUP_QUEUES.get(cleaned);
}

export function getFollowupQueue(key: string, settings: QueueSettings): FollowupQueueState {
  const cleaned = key.trim();
  const existing = FOLLOWUP_QUEUES.get(cleaned);
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
    paused: FOLLOWUP_QUEUE_PAUSES.has(cleaned),
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
  FOLLOWUP_QUEUES.set(cleaned, created);
  return created;
}

export function clearFollowupQueue(key: string): number {
  const cleaned = key.trim();
  const queue = getExistingFollowupQueue(cleaned);
  FOLLOWUP_QUEUE_PAUSES.delete(cleaned);
  if (!queue) {
    return 0;
  }
  const cleared = queue.items.length + queue.droppedCount;
  queue.items.length = 0;
  queue.droppedCount = 0;
  queue.summaryLines = [];
  queue.lastRun = undefined;
  queue.lastEnqueuedAt = 0;
  FOLLOWUP_QUEUES.delete(cleaned);
  return cleared;
}

export function refreshQueuedFollowupSession(params: {
  key: string;
  previousSessionId?: string;
  nextSessionId?: string;
  nextSessionFile?: string;
}): void {
  const cleaned = params.key.trim();
  if (!cleaned || !params.previousSessionId || !params.nextSessionId) {
    return;
  }
  if (params.previousSessionId === params.nextSessionId) {
    return;
  }
  const queue = getExistingFollowupQueue(cleaned);
  if (!queue) {
    return;
  }

  const rewriteRun = (run?: FollowupRun["run"]) => {
    if (!run || run.sessionId !== params.previousSessionId) {
      return;
    }
    run.sessionId = params.nextSessionId!;
    if (params.nextSessionFile?.trim()) {
      run.sessionFile = params.nextSessionFile;
    }
  };

  rewriteRun(queue.lastRun);
  for (const item of queue.items) {
    rewriteRun(item.run);
  }
}

export function pauseFollowupQueue(key: string): boolean {
  const cleaned = key.trim();
  if (!cleaned) {
    return false;
  }
  FOLLOWUP_QUEUE_PAUSES.set(cleaned, true);
  const queue = getExistingFollowupQueue(cleaned);
  if (queue) {
    queue.paused = true;
  }
  return true;
}

export function resumeFollowupQueue(key: string): boolean {
  const cleaned = key.trim();
  if (!cleaned) {
    return false;
  }
  FOLLOWUP_QUEUE_PAUSES.delete(cleaned);
  const queue = getExistingFollowupQueue(cleaned);
  if (!queue) {
    return false;
  }
  queue.paused = false;
  return queue.items.length > 0 || queue.droppedCount > 0;
}
