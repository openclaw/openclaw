import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptRawDeltaResult,
  SessionTranscriptReadScope,
} from "./session-accessor.sqlite-contract.js";
import {
  normalizeRawDeltaLimits,
  readRawDeltaInTransaction,
} from "./session-accessor.sqlite-raw-delta-read.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";

/** Read one generation-consistent raw transcript page without parsing excluded payload rows. */
export function readTranscriptRawDelta(
  scope: SessionTranscriptReadScope,
  limits: SessionTranscriptRawDeltaLimits = {},
): SessionTranscriptRawDeltaResult {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const { maxEvents, maxBytes } = normalizeRawDeltaLimits(limits);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      assertSessionTranscriptHot(database.db, resolved.sessionId);
      const beforeEventSeq = resolveSqliteSessionTranscriptReadFence({
        database,
        ...resolved,
      })?.beforeRawSeq;
      return readRawDeltaInTransaction(
        database.db,
        resolved,
        limits.cursor,
        maxEvents,
        maxBytes,
        beforeEventSeq,
      );
    },
    {
      databaseLabel: database.path,
      operationLabel: "session transcript raw delta",
    },
  );
}
