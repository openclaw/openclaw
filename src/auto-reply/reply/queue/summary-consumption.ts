import type { SessionControllerMailbox } from "../../../sessions/session-controller.mailbox.js";
import { completeFollowupRunLifecycle } from "./lifecycle.js";
import type { FollowupRun } from "./types.js";

export function consumeQueueSummaryDelivery(
  queue: Pick<
    SessionControllerMailbox,
    "summarySources" | "summaryLines" | "summaryElisions" | "droppedCount"
  >,
  delivery: { droppedCount: number; sources: readonly FollowupRun[] },
  completeLifecycles = true,
): void {
  let consumedCount = delivery.sources.length === 0 ? delivery.droppedCount : 0;
  for (const source of delivery.sources) {
    const sourceIndex = queue.summarySources.indexOf(source);
    const entry =
      sourceIndex < 0
        ? queue.summaryElisions.find(
            (candidate) => candidate.sources.includes(source) || candidate.sourceRefs.has(source),
          )
        : undefined;
    if (sourceIndex >= 0 || entry) {
      const index = entry
        ? entry.sources.indexOf(entry.sourceRefs.get(source) ?? source)
        : sourceIndex;
      if (index >= 0) {
        (entry?.sources ?? queue.summarySources).splice(index, 1);
        (entry?.summaryLines ?? queue.summaryLines).splice(index, 1);
      }
      consumedCount += 1;
      if (entry) {
        for (const [original, compact] of entry.sourceRefs) {
          if (compact === source || original === source) {
            entry.sourceRefs.delete(original);
          }
        }
        entry.count = entry.sources.length;
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
