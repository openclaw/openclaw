import { defaultRuntime } from "../../../runtime.js";
import { removeQueuedItemsByRef } from "../../../utils/queue-helpers.js";
import { completeFollowupRuns } from "./lifecycle.js";
import type { FOLLOWUP_QUEUES } from "./state.js";
import { consumeQueueSummaryDelivery } from "./summary-consumption.js";
import { isFollowupRunAborted, type FollowupRun } from "./types.js";

type AbortedFollowupQueueState = Pick<
  NonNullable<ReturnType<typeof FOLLOWUP_QUEUES.get>>,
  | "items"
  | "inFlight"
  | "droppedCount"
  | "summaryLines"
  | "summarySources"
  | "activeSummarySources"
  | "summaryElisions"
>;

/**
 * Cancellation sweep for queued work whose owner aborted before admission:
 * detaches it, settles each lifecycle as cancelled, then runs presentation cleanup.
 */
export async function dropAbortedFollowups(
  queue: AbortedFollowupQueueState,
  runFollowup: (run: FollowupRun) => Promise<void>,
): Promise<number> {
  // Waiting reservations are cancellable; started injections retain custody until their outcome.
  const canDrop = (run: FollowupRun) =>
    run.steerPending?.phase !== "injecting" &&
    isFollowupRunAborted(run) &&
    !queue.inFlight.has(run) &&
    !queue.activeSummarySources.has(run);
  const pending = queue.items.filter(canDrop);
  const summaries = [
    ...queue.summarySources,
    ...queue.summaryElisions.flatMap((entry) => entry.sources),
  ].filter(canDrop);
  // Detach identities and release both dedupe owners before ingress can retry.
  removeQueuedItemsByRef(queue.items, pending);
  consumeQueueSummaryDelivery(
    queue,
    { sources: summaries, droppedCount: summaries.length },
    "retained",
  );
  completeFollowupRuns(
    [...pending, ...summaries],
    (error) => {
      defaultRuntime.error?.(`followup queue cancellation settlement failed: ${String(error)}`);
    },
    "cancelled",
  );
  await Promise.all(
    pending.map(async (item) => {
      try {
        await runFollowup(item);
      } catch (error) {
        // Aborted work cannot run again; report failed presentation cleanup without restoring it.
        defaultRuntime.error?.(`followup queue cancellation cleanup failed: ${String(error)}`);
      }
    }),
  );
  return pending.length + summaries.length;
}
