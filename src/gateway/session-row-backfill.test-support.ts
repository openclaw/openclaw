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

type SessionRowCapture = Pick<SessionRowProjection, "capture">;

/**
 * Observe accepted publications so warm-read fixtures do not measure startup enrichment.
 * Pass a pending projection when creating it can publish rows before callers hold it.
 */
export function observeSessionRowBackfill(
  identities: string[],
  projection?: SessionRowCapture | Promise<SessionRowCapture>,
  identify: (row: records.MaterializedRow) => string = (row) => row.key,
) {
  const remaining = new Set(identities);
  const completed = createDeferredCore();
  let owner: SessionRowCapture | undefined;
  // Durable facts, including another projection's backfill, publish during materialization.
  let early: records.MaterializedRow[] | undefined = [];
  const accept = (row: records.MaterializedRow) => {
    if (
      owner &&
      owner.capture({
        agentId: row.agentId,
        key: row.key,
        storePath: row.storeTarget.storePath,
      }) !== row
    ) {
      return;
    }
    remaining.delete(identify(row));
    if (!remaining.size) {
      completed.resolve();
    }
  };
  const publish = records.publishTranscriptFields;
  const spy = vi.spyOn(records, "publishTranscriptFields").mockImplementation((...args) => {
    try {
      const changed = publish(...args);
      const [row] = args;
      if (early) {
        early.push(row);
      } else {
        accept(row);
      }
      return changed;
    } catch (error) {
      completed.reject(error);
      throw error;
    }
  });
  void Promise.resolve(projection).then((resolved) => {
    owner = resolved;
    const published = early ?? [];
    early = undefined;
    published.forEach(accept);
  }, completed.reject);
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
