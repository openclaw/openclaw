import { removeQueuedItemsByRef } from "../../../utils/queue-helpers.js";
import { clearFollowupDrainCallback, kickFollowupDrainIfIdle } from "./drain.js";
import { completeFollowupRunLifecycle } from "./lifecycle.js";
import { FOLLOWUP_QUEUES, followupQueueSources } from "./state.js";
import { consumeQueueSummaryDelivery } from "./summary-consumption.js";
import type { FollowupRun } from "./types.js";

/** Capture one exact active drain generation for post-recovery retirement. */
export function prepareStaleFollowupDrainRetirement(key: string): (() => void) | undefined {
  const queue = FOLLOWUP_QUEUES.get(key);
  if (!queue?.draining) {
    return undefined;
  }
  const drainOwner = queue.drainOwner;
  if (!drainOwner) {
    return undefined;
  }
  const activeSources = new Set(queue.inFlight);
  if (activeSources.size === 0) {
    return undefined;
  }
  // Recovery awaits owner cleanup before redeeming this closure. Revalidation
  // prevents an old recovery from fencing a queue that advanced to fresh work.
  return () => {
    if (
      FOLLOWUP_QUEUES.get(key) !== queue ||
      !queue.draining ||
      queue.drainOwner !== drainOwner ||
      activeSources.size !== queue.inFlight.size ||
      ![...activeSources].every((source) => queue.inFlight.has(source))
    ) {
      return;
    }

    // Active identities may already be side-effecting, so remove rather than replay them.
    removeQueuedItemsByRef(queue.items, [...activeSources]);
    const activeSummarySources = [...activeSources].filter((source) =>
      queue.activeSummarySources.has(source),
    );
    consumeQueueSummaryDelivery(
      queue,
      { droppedCount: activeSummarySources.length, sources: activeSummarySources },
      false,
    );
    const replacement = {
      ...queue,
      abortController: new AbortController(),
      items: [...queue.items],
      draining: false,
      drainOwner: undefined,
      inFlight: new Set<FollowupRun>(),
      summaryLines: [...queue.summaryLines],
      summarySources: [...queue.summarySources],
      activeSummarySources: new WeakSet<FollowupRun>(),
      summaryElisions: queue.summaryElisions.map((entry) => ({
        ...entry,
        sources: [...entry.sources],
        summaryLines: [...entry.summaryLines],
        // A late summary delivery must not resolve an old source into pending state.
        sourceRefs: new WeakMap<FollowupRun, FollowupRun>(),
      })),
    };
    for (const source of followupQueueSources(replacement)) {
      source.queueAbortSignal = replacement.abortController.signal;
    }
    const hasPendingWork = replacement.items.length > 0 || replacement.droppedCount > 0;
    if (hasPendingWork) {
      FOLLOWUP_QUEUES.set(key, replacement);
    } else {
      FOLLOWUP_QUEUES.delete(key);
      clearFollowupDrainCallback(key);
    }
    queue.items.length = 0;
    queue.droppedCount = 0;
    queue.summaryLines = [];
    queue.summarySources = [];
    queue.summaryElisions = [];
    queue.evictedSummaryCount = 0;
    queue.abortController.abort();
    for (const source of activeSources) {
      completeFollowupRunLifecycle(source);
    }
    if (hasPendingWork) {
      kickFollowupDrainIfIdle(key);
    }
  };
}
