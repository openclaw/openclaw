import { setImmediate as yieldToGateway } from "node:timers/promises";
import type { TranscriptProjectionPublicationOperations } from "./session-transcript-projection-publication.worker.js";

type ProjectionStatus = TranscriptProjectionPublicationOperations["preflight"]["output"];

/** Bound one pass even when foreign commits keep restarting admission. */
export async function drainTranscriptIndexStatus<Status extends ProjectionStatus>(
  maintain: () => Promise<Status>,
  previousTraversal?: ProjectionStatus["traversal"],
): Promise<Status> {
  let traversal = previousTraversal;
  for (let batch = 0; ; batch++) {
    const result = await maintain();
    const completedElsewhere =
      result.traversal &&
      traversal &&
      result.traversal.schemaVersion === traversal.schemaVersion &&
      result.traversal.completedTraversals > traversal.completedTraversals;
    // Schema changes and native-owner counter resets start a fresh observation window.
    traversal = result.traversal;
    if (completedElsewhere) {
      return { ...result, traversalComplete: true };
    }
    // At most 4,096 candidates per pass; the existing reconcile cadence resumes the cursor.
    if (!result.hasMore || result.traversalComplete || batch === 31) {
      return result;
    }
    await yieldToGateway();
  }
}
