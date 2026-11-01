import type { resolveTextCommand } from "../auto-reply/commands-registry.js";
import {
  DEFAULT_QUEUE_CAP,
  DEFAULT_QUEUE_DEBOUNCE_MS,
  DEFAULT_QUEUE_DROP,
} from "../auto-reply/reply/queue/state.js";
import type { QueueSettings } from "../auto-reply/reply/queue/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createDeferredCore } from "../shared/deferred.js";
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
  const pending = listPendingLocalInputs(runs, params);
  if (pending.length) {
    return pending.at(-1);
  }
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

/** Local TUI custody has not reached the controller until its predecessor settles. */
function listPendingLocalInputs(
  runs: ReadonlyMap<string, LocalRunState>,
  scope: { sessionKey: string; agentId?: string },
): QueuedSessionRun[] {
  const depth = (run: LocalRunState) => {
    let result = 0;
    for (let previous = run.queuedAfter; previous; previous = previous.run.queuedAfter) {
      result++;
    }
    return result;
  };
  return [...runs]
    .flatMap(([runId, run]) =>
      isSameLocalRunScope(run, scope) &&
      run.promise &&
      run.queuedAfter &&
      run.pendingQueue &&
      !run.controller.signal.aborted &&
      !run.question
        ? [{ runId, run, promise: run.promise }]
        : [],
    )
    .toSorted((a, b) => depth(a.run) - depth(b.run));
}

/** Only singleton custody has an unambiguous original message to promote. */
export function listInterruptibleLocalInputs(
  runs: ReadonlyMap<string, LocalRunState>,
  scope: { sessionKey: string; agentId?: string },
): QueuedSessionRun[] {
  return listPendingLocalInputs(runs, scope).filter(
    (item) => item.run.pendingQueue?.messages.length === 1,
  );
}

/** Reorder existing custody in place; only the captured incumbent is canceled by the caller. */
export function promotePendingLocalInput(
  runs: ReadonlyMap<string, LocalRunState>,
  scope: { sessionKey: string; agentId?: string },
  runId: string,
): QueuedSessionRun | undefined {
  const queued = listPendingLocalInputs(runs, scope);
  const index = queued.findIndex((item) => item.runId === runId);
  const selected = queued[index];
  const incumbent = queued[0]?.run.queuedAfter;
  if (!selected || !incumbent || selected.run.pendingQueue?.messages.length !== 1) {
    return undefined;
  }
  const updates: Array<[LocalRunState, QueuedSessionRun]> = [[selected.run, incumbent]];
  if (index > 0) {
    updates.push([queued[0]!.run, selected]);
    const next = queued[index + 1];
    if (next) {
      updates.push([next.run, queued[index - 1]!]);
    }
  }
  for (const [run, predecessor] of updates) {
    // Selecting the head still waits on this same writer; it is not a queue change.
    if (run.queuedAfter === predecessor) {
      continue;
    }
    const changed = run.queueSelectionChanged;
    run.queuedAfter = predecessor;
    run.queueSelectionChanged = createDeferredCore();
    changed.resolve();
  }
  return incumbent;
}

function isLocalRunAbortable(run: LocalRunState): boolean {
  return !run.lifecycleEnded || run.promise !== undefined;
}

export function abortLocalSessionRuns(
  runs: ReadonlyMap<string, LocalRunState>,
  scope: { sessionKey: string; agentId?: string },
): void {
  for (const run of runs.values()) {
    if (isSameLocalRunScope(run, scope) && !run.question && isLocalRunAbortable(run)) {
      run.controller.abort();
    }
  }
}

export function abortLocalChatRuns(
  runs: ReadonlyMap<string, LocalRunState>,
  opts: { sessionKey: string; agentId?: string; runId?: string },
  resolveDefaultAgent: () => string,
) {
  const runIds: string[] = [];
  const candidates = opts.runId ? [[opts.runId, runs.get(opts.runId)] as const] : runs;
  for (const [runId, run] of candidates) {
    if (!run || (!opts.runId && run.question) || run.sessionKey !== opts.sessionKey) {
      continue;
    }
    if (opts.sessionKey === "global") {
      const defaultAgentId = opts.agentId && run.agentId ? undefined : resolveDefaultAgent();
      const requestedAgentId = opts.agentId ? normalizeAgentId(opts.agentId) : defaultAgentId;
      const runAgentId = run.agentId ? normalizeAgentId(run.agentId) : defaultAgentId;
      if (runAgentId !== requestedAgentId) {
        continue;
      }
    }
    if (!isLocalRunAbortable(run)) {
      continue;
    }
    run.controller.abort();
    runIds.push(runId);
  }
  return { ok: true, aborted: runIds.length > 0, runIds };
}

export function applyEmbeddedQueueControl(
  runs: ReadonlyMap<string, LocalRunState>,
  scope: { sessionKey: string; agentId?: string },
  command: ReturnType<typeof resolveTextCommand>,
): { text: string; incumbent?: QueuedSessionRun } | undefined {
  if (command?.command.key !== "interrupt" && command?.command.key !== "followupmode") {
    return undefined;
  }
  if (command.command.key === "followupmode") {
    return {
      text: "This offline TUI has no linked personal profile. Use /queue followup|steer|interrupt for this session, or connect to a Gateway to use /followupmode.",
    };
  }
  if (!command.args || command.args === "list") {
    const queued = listInterruptibleLocalInputs(runs, scope);
    return {
      text: queued.length
        ? "Queued input IDs (use /interrupt <id>):\n" + queued.map((item) => item.runId).join("\n")
        : "No safely interruptible queued input remains.",
    };
  }
  const incumbent = promotePendingLocalInput(runs, scope, command.args);
  return {
    incumbent,
    text: incumbent
      ? "Interrupt & send requested for the original queued input. The previous writer may need to settle; other queued inputs are unchanged."
      : "That input is no longer safely queued. Nothing was resent or interrupted.",
  };
}
