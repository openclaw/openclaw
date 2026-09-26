import type { QueueSettings } from "../auto-reply/reply/queue/types.js";
import type { AssistantTextSnapshot } from "../gateway/agent-event-assistant-text.js";
import { settlesWithin } from "../shared/settle-within.js";
import { buildCollectPrompt, previewQueueSummaryPrompt } from "../utils/queue-helpers.js";
import { resolveLocalRunShutdownGraceMs } from "./local-run-shutdown.js";

export type LocalRunState = {
  sessionKey: string;
  agentId: string;
  controller: AbortController;
  buffer: string;
  assistantScope?: AssistantTextSnapshot["scope"];
  managedMediaUrls: Set<string>;
  lastBroadcastText?: string;
  question?: string;
  finishing: boolean;
  lifecycleEnded: boolean;
  lifecycleStopReason?: string;
  lifecycleYielded?: boolean;
  toolErrorSummary?: string;
  terminalState?: "provisional" | "final";
  registered: boolean;
  pendingQueue?: {
    mode: "followup" | "collect";
    messages: string[];
    debounceMs: number;
    lastEnqueuedAt: number;
    dropPolicy: NonNullable<QueueSettings["dropPolicy"]>;
    droppedCount: number;
    summaryLines: string[];
  };
  queuedAfter?: QueuedSessionRun;
  queuedRunReady: Promise<void>;
  markQueuedRunReady: () => void;
};

export type QueuedSessionRun = {
  runId: string;
  run: LocalRunState;
  promise: Promise<void>;
};

export function timeoutSecondsFromMs(timeoutMs?: number): string | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return undefined;
  }
  return String(Math.max(0, Math.ceil(timeoutMs / 1000)));
}

export function buildLocalQueuedPrompt(queue: NonNullable<LocalRunState["pendingQueue"]>): string {
  const summary = previewQueueSummaryPrompt({
    state: queue,
    noun: "message",
  });
  const prompt =
    queue.mode === "collect" && queue.messages.length > 1
      ? buildCollectPrompt({
          title: "[Queued messages while agent was busy]",
          items: queue.messages,
          renderItem: (message, index) => `---\nQueued #${index + 1}\n${message}`,
        })
      : (queue.messages[0] ?? "");
  return [summary, prompt].filter(Boolean).join("\n\n");
}

export async function waitForLocalRunShutdown(promises: Promise<void>[]): Promise<boolean> {
  if (promises.length === 0) {
    return true;
  }
  const timeoutMs = resolveLocalRunShutdownGraceMs();
  if (timeoutMs <= 0) {
    return false;
  }
  return await settlesWithin(Promise.allSettled(promises), timeoutMs);
}

export async function waitForQueuedLocalRun(
  previousRun: QueuedSessionRun,
  runId: string,
): Promise<void> {
  await previousRun.run.queuedRunReady;
  if (previousRun.run.controller.signal.aborted && previousRun.run.queuedAfter) {
    // Preserve canceled-slot ancestry and the live run's bounded maintenance wait.
    return await waitForQueuedLocalRun(previousRun.run.queuedAfter, runId);
  }
  if (!previousRun.run.finishing && !previousRun.run.lifecycleEnded) {
    await previousRun.promise;
    return;
  }
  const timeoutMs = resolveLocalRunShutdownGraceMs();
  if (timeoutMs <= 0 || !(await settlesWithin(previousRun.promise, timeoutMs))) {
    throw new Error(
      `timed out waiting for previous local run to finish post-turn maintenance for ${runId}`,
    );
  }
}
