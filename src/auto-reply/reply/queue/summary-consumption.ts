import { completeFollowupRunLifecycle } from "./lifecycle.js";
import type { FOLLOWUP_QUEUES } from "./state.js";
import type { FollowupRun } from "./types.js";

type FollowupQueueState = NonNullable<ReturnType<typeof FOLLOWUP_QUEUES.get>>;

export function consumeQueueSummaryDelivery(
  queue: Pick<
    FollowupQueueState,
    "summarySources" | "summaryLines" | "summaryElisions" | "droppedCount"
  >,
  delivery: { droppedCount: number; sources: readonly FollowupRun[] },
  completeLifecycles = true,
): void {
  let consumedCount = delivery.sources.length === 0 ? delivery.droppedCount : 0;
  for (const source of delivery.sources) {
    const sourceIndex = queue.summarySources.indexOf(source);
    if (sourceIndex >= 0) {
      queue.summarySources.splice(sourceIndex, 1);
      queue.summaryLines.splice(sourceIndex, 1);
      consumedCount += 1;
    } else {
      const entry = queue.summaryElisions.find(
        (candidate) => candidate.sources.includes(source) || candidate.sourceRefs.has(source),
      );
      if (entry) {
        const elidedSourceIndex = entry.sources.indexOf(entry.sourceRefs.get(source) ?? source);
        if (elidedSourceIndex >= 0) {
          entry.sources.splice(elidedSourceIndex, 1);
          entry.summaryLines.splice(elidedSourceIndex, 1);
        }
        consumedCount += 1;
        if (entry.sources.length === 0) {
          queue.summaryElisions.splice(queue.summaryElisions.indexOf(entry), 1);
        }
      }
    }
    if (completeLifecycles) {
      completeFollowupRunLifecycle(source);
    }
  }
  queue.droppedCount = Math.max(0, queue.droppedCount - consumedCount);
}
