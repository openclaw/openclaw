// Clears follow-up queues and their session command lanes.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveEmbeddedSessionLane } from "../../../agents/embedded-agent-runner/lanes.js";
import { clearCommandLane } from "../../../process/command-queue.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { defaultRuntime } from "../../../runtime.js";
import { removeQueuedItemsByRef } from "../../../utils/queue-helpers.js";
import { clearFollowupDrainCallback } from "./drain.js";
import { completeFollowupRunLifecycle } from "./lifecycle.js";
import { clearFollowupQueue, FOLLOWUP_QUEUES, followupQueueSources } from "./state.js";
import { consumeQueueSummaryDelivery } from "./summary-consumption.js";
import type { FollowupRun } from "./types.js";

export type ClearSessionQueueResult = {
  followupCleared: number;
  laneCleared: number;
  keys: string[];
};

/** Capture pending sources before Stop callbacks can replace their queue or session. */
export function prepareSessionFollowupCleanup(params: {
  keys: Array<string | undefined>;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  assertCurrent: () => void;
}): () => number {
  const keys = new Set(
    params.keys.map((key) => normalizeOptionalString(key)).filter((key) => key !== undefined),
  );
  const targetAgentId = normalizeAgentId(params.agentId);
  const captures = [...keys].flatMap((key) => {
    const queue = FOLLOWUP_QUEUES.get(key);
    if (!queue) {
      return [];
    }
    const isPending = (source: FollowupRun) =>
      source.steerPending?.phase !== "injecting" &&
      !queue.inFlight.has(source) &&
      !queue.activeSummarySources.has(source);
    // Admission can retarget the next claim before run.sessionId is refreshed.
    // Neither identity may transfer this Stop to another incarnation.
    const sources = [...new Set(followupQueueSources(queue))]
      .filter(
        (source) =>
          isPending(source) &&
          normalizeOptionalString(source.run.agentId) !== undefined &&
          normalizeAgentId(source.run.agentId) === targetAgentId &&
          source.run.sessionKey === params.sessionKey &&
          source.run.sessionId === params.sessionId &&
          (source.admissionSessionId === undefined ||
            source.admissionSessionId === params.sessionId),
      )
      .map((source) => ({
        source,
        run: source.run,
        agentId: source.run.agentId,
        sessionKey: source.run.sessionKey,
        sessionId: source.run.sessionId,
        admissionSessionId: source.admissionSessionId,
        lifecycle: source.turnAdoptionLifecycle,
      }));
    return [{ key, queue, isPending, sources }];
  });
  let consumed = false;
  return () => {
    if (consumed) {
      return 0;
    }
    consumed = true;
    let removed = 0;
    for (const { key, queue, isPending, sources } of captures) {
      params.assertCurrent();
      if (FOLLOWUP_QUEUES.get(key) !== queue) {
        continue;
      }
      const matchesCapture = (source: FollowupRun, capture: (typeof sources)[number]) =>
        isPending(source) &&
        source.run === capture.run &&
        source.run.agentId === capture.agentId &&
        source.run.sessionKey === capture.sessionKey &&
        source.run.sessionId === capture.sessionId &&
        source.admissionSessionId === capture.admissionSessionId &&
        source.turnAdoptionLifecycle === capture.lifecycle;
      const current = sources.filter((capture) => matchesCapture(capture.source, capture));
      const pending = current.flatMap(({ source }) =>
        queue.items.includes(source) ? [source] : [],
      );
      // Overflow records original -> compact-source custody. Follow only that owner mapping,
      // retaining both original facts and the compact source's pending generation.
      const summaries = current
        .filter((capture) => {
          const source = capture.source;
          return (
            queue.summarySources.includes(source) ||
            queue.summaryElisions.some((entry) => {
              const mapped = entry.sourceRefs.get(source) ?? source;
              return entry.sources.includes(mapped) && matchesCapture(mapped, capture);
            })
          );
        })
        .map(({ source }) => source);
      // Detach the whole accepted set before lifecycle callbacks can revoke or re-enter Stop.
      removeQueuedItemsByRef(queue.items, pending);
      consumeQueueSummaryDelivery(
        queue,
        { sources: summaries, droppedCount: summaries.length },
        false,
      );
      const detached = new Set([...pending, ...summaries]);
      removed += detached.size;
      for (const source of detached) {
        try {
          completeFollowupRunLifecycle(source);
        } catch (error) {
          defaultRuntime.error?.(`followup queue cancellation settlement failed: ${String(error)}`);
        }
      }
      // Settlement of accepted removals is unconditional; later effects need current authority.
      params.assertCurrent();
      if (
        FOLLOWUP_QUEUES.get(key) === queue &&
        !queue.draining &&
        !queue.drainOwner &&
        queue.items.length === 0 &&
        queue.inFlight.size === 0 &&
        queue.droppedCount === 0
      ) {
        FOLLOWUP_QUEUES.delete(key);
        clearFollowupDrainCallback(key);
      }
    }
    return removed;
  };
}

export function clearSessionQueues(keys: Array<string | undefined>): ClearSessionQueueResult {
  const seen = new Set<string>();
  let followupCleared = 0;
  let laneCleared = 0;
  const clearedKeys: string[] = [];

  for (const key of keys) {
    const cleaned = normalizeOptionalString(key);
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    clearedKeys.push(cleaned);
    followupCleared += clearFollowupQueue(cleaned);
    clearFollowupDrainCallback(cleaned);
    laneCleared += clearCommandLane(resolveEmbeddedSessionLane(cleaned));
  }

  return { followupCleared, laneCleared, keys: clearedKeys };
}
