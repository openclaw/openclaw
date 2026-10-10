import { vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import * as records from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";

/** Observe accepted publications so warm-read fixtures do not measure startup enrichment. */
export function observeSessionRowBackfill(
  identities: string[],
  projection?: Pick<SessionRowProjection, "capture">,
  identify: (row: records.MaterializedRow) => string = (row) => row.key,
) {
  const remaining = new Set(identities);
  const completed = createDeferredCore();
  const publish = records.publishTranscriptFields;
  const spy = vi.spyOn(records, "publishTranscriptFields").mockImplementation((...args) => {
    try {
      const changed = publish(...args);
      const [row] = args;
      if (
        projection &&
        projection.capture({
          agentId: row.agentId,
          key: row.key,
          storePath: row.storeTarget.storePath,
        }) !== row
      ) {
        return changed;
      }
      remaining.delete(identify(row));
      if (!remaining.size) {
        completed.resolve();
      }
      return changed;
    } catch (error) {
      completed.reject(error);
      throw error;
    }
  });
  return completed.promise.finally(() => spy.mockRestore());
}
