import {
  DEFAULT_QUEUE_CAP,
  DEFAULT_QUEUE_DEBOUNCE_MS,
  DEFAULT_QUEUE_DROP,
} from "../auto-reply/reply/queue/state.js";
import type { QueueSettings } from "../auto-reply/reply/queue/types.js";
import { applyQueueDropPolicy } from "../utils/queue-helpers.js";
import {
  isSameLocalRunScope,
  type LocalRunState,
  type QueuedSessionRun,
} from "./embedded-local-run.js";

export function findQueuedSessionRun(
  runs: ReadonlyMap<string, LocalRunState>,
  params: { sessionKey: string; agentId?: string },
): QueuedSessionRun | undefined {
  let queuedAfter: QueuedSessionRun | undefined;
  for (const [runId, run] of runs) {
    if (isSameLocalRunScope(run, params) && !run.question && run.promise) {
      queuedAfter = { runId, run, promise: run.promise };
    }
  }
  return queuedAfter;
}

type LocalPendingMessage = {
  run: LocalRunState;
  messageIndex: number;
  message: string;
};

export function enqueuePendingLocalMessage(
  runs: ReadonlyMap<string, LocalRunState>,
  params: {
    runScope: { sessionKey: string; agentId?: string };
    message: string;
    settings: QueueSettings;
  },
):
  | { kind: "handled"; runId: string }
  | { kind: "rejected" }
  | { kind: "enqueue"; queue: NonNullable<LocalRunState["pendingQueue"]> } {
  const pendingMessages: LocalPendingMessage[] = [];
  for (const run of runs.values()) {
    if (isSameLocalRunScope(run, params.runScope) && run.pendingQueue) {
      run.pendingQueue.messages.forEach((message, messageIndex) => {
        pendingMessages.push({ run, messageIndex, message });
      });
    }
  }
  const summaryLines: string[] = [];
  const overflowQueue = {
    items: [...pendingMessages],
    cap: params.settings.cap ?? DEFAULT_QUEUE_CAP,
    dropPolicy: params.settings.dropPolicy ?? DEFAULT_QUEUE_DROP,
    droppedCount: 0,
    summaryLines,
  };
  const admitted = applyQueueDropPolicy({
    queue: overflowQueue,
    summarize: (item) => item.message,
  });
  if (!admitted) {
    return { kind: "rejected" };
  }

  const retained = new Set(overflowQueue.items);
  const droppedByRun = new Map<LocalRunState, number[]>();
  for (const dropped of pendingMessages) {
    if (retained.has(dropped)) {
      continue;
    }
    const indices = droppedByRun.get(dropped.run) ?? [];
    indices.push(dropped.messageIndex);
    droppedByRun.set(dropped.run, indices);
  }
  const inheritedSummaryLines: string[] = [];
  for (const [run, indices] of droppedByRun) {
    for (const index of indices.toSorted((a, b) => b - a)) {
      run.pendingQueue?.messages.splice(index, 1);
    }
    if (run.pendingQueue?.messages.length === 0) {
      inheritedSummaryLines.push(...run.pendingQueue.summaryLines);
      overflowQueue.droppedCount += run.pendingQueue.droppedCount;
      run.controller.abort();
    }
  }
  overflowQueue.summaryLines.unshift(...inheritedSummaryLines);
  if (overflowQueue.summaryLines.length > overflowQueue.cap) {
    overflowQueue.summaryLines.splice(0, overflowQueue.summaryLines.length - overflowQueue.cap);
  }

  const enqueuedAt = Date.now();
  for (const run of runs.values()) {
    if (!isSameLocalRunScope(run, params.runScope) || !run.pendingQueue) {
      continue;
    }
    run.pendingQueue.lastEnqueuedAt = enqueuedAt;
    run.pendingQueue.debounceMs = params.settings.debounceMs ?? DEFAULT_QUEUE_DEBOUNCE_MS;
  }

  if (params.settings.mode === "collect") {
    const target = [...runs.entries()].findLast(
      ([, run]) => isSameLocalRunScope(run, params.runScope) && run.pendingQueue,
    );
    const targetQueue = target?.[1].pendingQueue;
    if (target && targetQueue?.mode === "collect" && !target[1].controller.signal.aborted) {
      const [targetRunId] = target;
      targetQueue.messages.push(params.message);
      targetQueue.dropPolicy = params.settings.dropPolicy ?? DEFAULT_QUEUE_DROP;
      targetQueue.droppedCount += overflowQueue.droppedCount;
      targetQueue.summaryLines.push(...overflowQueue.summaryLines);
      return { kind: "handled", runId: targetRunId };
    }
  }

  return {
    kind: "enqueue",
    queue: {
      mode: params.settings.mode === "collect" ? "collect" : "followup",
      messages: [params.message],
      debounceMs: params.settings.debounceMs ?? DEFAULT_QUEUE_DEBOUNCE_MS,
      lastEnqueuedAt: enqueuedAt,
      dropPolicy: params.settings.dropPolicy ?? DEFAULT_QUEUE_DROP,
      droppedCount: overflowQueue.droppedCount,
      summaryLines: overflowQueue.summaryLines,
    },
  };
}
