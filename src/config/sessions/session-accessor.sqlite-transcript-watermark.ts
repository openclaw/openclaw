// Transcript watermark reader: the (generation, max seq) token pair that
// validates transcript-derived caches (derived titles, branch summaries).
// Kept apart from the active-events reader so cache validation stays a
// dependency-light import for gateway callers.
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  readSessionTranscriptHotWatermark,
  type SessionTranscriptWatermark,
} from "./session-accessor.sqlite-transcript-watermark-read.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";

/** Reads the append and rewrite tokens that validate transcript-derived caches. */
export function readSessionTranscriptWatermark(
  scope: SessionTranscriptReadScope,
): SessionTranscriptWatermark {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(
        database.db,
        () => {
          const watermark = readSessionTranscriptHotWatermark(database, resolved.sessionId);
          const cold = readSessionColdTranscript(database.db, resolved.sessionId);
          return { ...watermark, maxSeq: cold?.last_seq ?? watermark.maxSeq };
        },
        { databaseLabel: database.path, operationLabel: "session transcript watermark read" },
      ),
    toDatabaseOptions(resolved),
    { throwOnMissingTable: true },
  );
  return result.found ? result.value : { generation: null, maxSeq: null };
}
