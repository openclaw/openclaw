import { vi } from "vitest";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
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

/** Emulate a session last written by a build without durable transcript-row facts. */
export function clearStoredSessionRowTranscriptForTest(scope: SessionTranscriptReadScope) {
  const options = toDatabaseOptions(resolveSqliteTranscriptReadScope(scope));
  openOpenClawAgentDatabase(options)
    .db.prepare(
      "UPDATE session_windows SET row_transcript_json = NULL, row_transcript_updated_at = NULL WHERE session_id = ?",
    )
    .run(scope.sessionId);
}
