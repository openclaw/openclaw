import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  withFreshOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly-open.js";
import { readSessionBranchSummaries } from "./session-accessor.sqlite-branch-summaries.js";
import type {
  SessionBranchSummaryReadRequest,
  SessionBranchSummaryReadResult,
} from "./session-accessor.sqlite-branches.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { readSessionTranscriptHotWatermark } from "./session-accessor.sqlite-transcript-watermark-read.js";

export function readSessionBranchSnapshot(
  database: OpenClawAgentReadOnlyDatabase,
  request: Pick<SessionBranchSummaryReadRequest, "sessionKey" | "previous">,
): SessionBranchSummaryReadResult {
  return runSqliteReadSnapshotSync<SessionBranchSummaryReadResult>(
    database.db,
    () => {
      const databaseIdentity = readOpenClawAgentDatabaseIdentity(database).identity;
      const entry = readSessionEntryRow(database, request.sessionKey, "list")?.entry;
      if (!entry?.sessionId) {
        return { status: "missing-session" };
      }
      // The watermark and rows must describe the same snapshot, even when a peer appends.
      const watermark = readSessionTranscriptHotWatermark(database, entry.sessionId, {
        requireHot: true,
      });
      const previous = request.previous;
      const cached =
        previous?.source?.sessionId === entry.sessionId &&
        previous.source.databaseIdentity === databaseIdentity &&
        previous.generation === watermark.generation &&
        previous.maxSeq !== null &&
        watermark.maxSeq !== null &&
        previous.maxSeq <= watermark.maxSeq
          ? previous
          : undefined;
      const summaries =
        cached?.maxSeq === watermark.maxSeq
          ? cached
          : readSessionBranchSummaries(database, entry.sessionId, cached);
      return {
        status: "ok",
        source:
          typeof databaseIdentity === "string"
            ? { sessionId: entry.sessionId, databaseIdentity }
            : undefined,
        ...watermark,
        appendSafe: summaries.appendSafe,
        branches: summaries.branches,
      };
    },
    { operationLabel: "session branch summaries read" },
  );
}

/** The transcript worker opens and closes its own read-only handle; only summaries leave it. */
export function readSessionBranchSummariesInWorker(
  request: SessionBranchSummaryReadRequest,
): SessionBranchSummaryReadResult {
  const result = withFreshOpenClawAgentDatabaseReadOnly(
    (database) => readSessionBranchSnapshot(database, request),
    request.database,
  );
  return result.found ? result.value : { status: "missing-session" };
}
