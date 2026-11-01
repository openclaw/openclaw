import type { QueueSettings } from "../auto-reply/reply/queue/types.js";
import type { createDraftStreamLoop } from "../channels/draft-stream-loop.js";
import type { AssistantTextSnapshot } from "../gateway/agent-event-assistant-text.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
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
  textUpdates?: ReturnType<typeof createDraftStreamLoop<boolean>>;
  question?: string;
  explicitFollowup?: true;
  finishing: boolean;
  lifecycleEnded: boolean;
  lifecycleStopReason?: string;
  lifecycleYielded?: boolean;
  toolErrorSummary?: string;
  localModelMayStillBeFinishing?: true;
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
  queueSelectionChanged: ReturnType<typeof createDeferredCore<void>>;
  promise?: Promise<void>;
  queuedRunReady: Promise<void>;
  markQueuedRunReady: () => void;
};

export type QueuedSessionRun = {
  runId: string;
  run: LocalRunState;
  promise: Promise<void>;
};

export function createLocalRunState(
  runId: string,
  initial: Pick<
    LocalRunState,
    "sessionKey" | "agentId" | "question" | "explicitFollowup" | "pendingQueue" | "queuedAfter"
  >,
): LocalRunState {
  const controller = new AbortController();
  const readiness = createDeferredCore();
  const run: LocalRunState = {
    ...initial,
    controller,
    buffer: "",
    managedMediaUrls: new Set(),
    finishing: false,
    lifecycleEnded: false,
    registered: false,
    queuedRunReady: readiness.promise,
    queueSelectionChanged: createDeferredCore(),
    markQueuedRunReady: readiness.resolve,
  };
  controller.signal.addEventListener(
    "abort",
    () => {
      // Capture before downstream abort listeners clear the provider wait.
      if (getAgentRunContext(runId)?.localModelWait) {
        run.localModelMayStillBeFinishing = true;
      }
    },
    { once: true },
  );
  return run;
}

export function timeoutSecondsFromMs(timeoutMs?: number): string | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return undefined;
  }
  return String(Math.max(0, Math.ceil(timeoutMs / 1000)));
}

export function buildLocalQueuedPrompt(queue: NonNullable<LocalRunState["pendingQueue"]>): string {
  const summary = previewQueueSummaryPrompt(queue);
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

async function waitForLocalPredecessorSettlement(
  previousRun: QueuedSessionRun,
  runId: string,
): Promise<void> {
  await previousRun.run.queuedRunReady;
  if (previousRun.run.controller.signal.aborted && previousRun.run.queuedAfter) {
    // Preserve canceled-slot ancestry and the live run's bounded maintenance wait.
    return await waitForLocalPredecessorSettlement(previousRun.run.queuedAfter, runId);
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

/** A queued control may change the predecessor, never the accepted run or payload. */
export async function waitForQueuedLocalRun(run: LocalRunState, runId: string): Promise<void> {
  while (run.queuedAfter) {
    const previous = run.queuedAfter;
    await Promise.race([
      waitForLocalPredecessorSettlement(previous, runId),
      run.queueSelectionChanged.promise,
    ]);
    if (run.queuedAfter === previous) {
      return;
    }
  }
}

export function isSameLocalRunScope(
  run: LocalRunState,
  params: { sessionKey: string; agentId?: string },
) {
  return (
    run.sessionKey === params.sessionKey &&
    (params.sessionKey !== "global" || run.agentId === params.agentId)
  );
}
