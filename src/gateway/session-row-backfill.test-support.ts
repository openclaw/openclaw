import { setImmediate as nextTurn } from "node:timers/promises";
import { vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import * as backfill from "./session-row-transcript-backfill.js";

/** Observe real background work so warm-read fixtures do not measure startup enrichment. */
export function observeSessionRowBackfill(sessionKeys: string[]) {
  const remaining = new Set(sessionKeys);
  const completed = createDeferredCore();
  const read = backfill.backfillSessionRowTranscriptFields;
  const spy = vi
    .spyOn(backfill, "backfillSessionRowTranscriptFields")
    .mockImplementation(async (params) => {
      try {
        const result = await read(params);
        remaining.delete(params.sessionKey);
        if (!remaining.size) {
          completed.resolve();
        }
        return result;
      } catch (error) {
        completed.reject(error);
        throw error;
      }
    });
  return completed.promise.then(nextTurn).finally(() => spy.mockRestore());
}
