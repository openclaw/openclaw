// Consumes exact overflow sources without disturbing sibling summary accounting.
import { expectDefined } from "@openclaw/normalization-core";
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
      const elisionIndex = queue.summaryElisions.findIndex(
        (entry) => entry.sources.includes(source) || entry.sourceRefs.has(source),
      );
      if (elisionIndex >= 0) {
        const entry = expectDefined(
          queue.summaryElisions[elisionIndex],
          "summary elisions entry at elision index",
        );
        const elidedSourceIndex = entry.sources.indexOf(entry.sourceRefs.get(source) ?? source);
        if (elidedSourceIndex >= 0) {
          entry.sources.splice(elidedSourceIndex, 1);
          entry.summaryLines.splice(elidedSourceIndex, 1);
        }
        entry.count = entry.sources.length;
        consumedCount += 1;
        if (entry.sources.length === 0) {
          queue.summaryElisions.splice(elisionIndex, 1);
        }
      }
    }
    if (completeLifecycles) {
      completeFollowupRunLifecycle(source);
    }
  }
  queue.droppedCount = Math.max(0, queue.droppedCount - consumedCount);
}
