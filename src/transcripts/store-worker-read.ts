import { ok } from "@openclaw/normalization-core/result";
import type { EngineConnection } from "../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../infra/sqlite-transaction.js";
import type { WorkerWriteOperationContext } from "../state/worker-operation-registry.js";
import { ensureMeetingTranscriptsSchema } from "./sqlite-schema.js";
import {
  queryTranscriptReadEntries,
  readLatestTranscriptEntry,
  readStoredTranscriptNotes,
  readTranscriptEntry,
  readTranscriptLibraryEntry,
  TranscriptLibraryError,
} from "./store-read.js";
import {
  readTranscriptCanonicalSessionRow,
  readTranscriptExportOwnership,
  readTranscriptExportPathCollisions,
  readTranscriptExportPathOwners,
  readTranscriptSessionByIdentity,
  readTranscriptSessionEntries,
  readTranscriptSessionMatches,
  readStoredTranscriptSummary,
  readTranscriptUtterances,
  readTranscriptSummarySnapshot,
  readTranscriptJsonlDigest,
} from "./store-sqlite-read.js";
import {
  readRecentStoppedTranscriptSession,
  readTranscriptSummaryInputRevision,
} from "./store-sqlite.js";
import type { TranscriptReadOperations, TranscriptReadRequests } from "./store-worker-contract.js";

/** Expected reader refusals retain their domain type; native failures use the shared codec. */
function readTranscript<Key extends keyof TranscriptReadRequests>(
  read: (
    database: EngineConnection,
    params: TranscriptReadRequests[Key]["input"],
  ) => TranscriptReadRequests[Key]["output"],
) {
  return (
    input: TranscriptReadOperations[Key]["input"],
    context: WorkerWriteOperationContext,
  ): TranscriptReadOperations[Key]["output"] => {
    const database = context.open();
    ensureMeetingTranscriptsSchema({
      database,
      ...context.stateOptions(),
      readOnly: input.readOnly,
    });
    try {
      return ok(read(database.db, input.params));
    } catch (error) {
      if (!(error instanceof TranscriptLibraryError)) {
        throw error;
      }
      return {
        ok: false as const,
        error: { type: error.type, message: error.message, maxBytes: error.maxBytes },
      };
    }
  };
}

export const transcriptReadOperations = {
  "transcripts.canonicalSessionRow": readTranscript<"transcripts.canonicalSessionRow">(
    (db, { selector }) => readTranscriptCanonicalSessionRow(db, selector),
  ),
  "transcripts.readEntries": readTranscript<"transcripts.readEntries">(queryTranscriptReadEntries),
  "transcripts.exportOwnership": readTranscript<"transcripts.exportOwnership">((db, { session }) =>
    readTranscriptExportOwnership(db, session),
  ),
  "transcripts.exportPathCollisions": readTranscript<"transcripts.exportPathCollisions">(
    (db, { exportKey }) => readTranscriptExportPathCollisions(db, exportKey),
  ),
  "transcripts.exportPathOwners": readTranscript<"transcripts.exportPathOwners">(
    (db, { exportKey }) => readTranscriptExportPathOwners(db, exportKey),
  ),
  "transcripts.summarySnapshot": readTranscript<"transcripts.summarySnapshot">(
    (db, { session, maxUtterances }) =>
      runSqliteReadSnapshotSync(db, () =>
        readTranscriptSummarySnapshot(db, session, maxUtterances),
      ),
  ),
  "transcripts.sessionEntries": readTranscript<"transcripts.sessionEntries">((db) =>
    runSqliteReadSnapshotSync(db, () => readTranscriptSessionEntries(db)),
  ),
  "transcripts.matches": readTranscript<"transcripts.matches">((db, { value }) =>
    runSqliteReadSnapshotSync(db, () => readTranscriptSessionMatches(db, value)),
  ),
  "transcripts.session": readTranscript<"transcripts.session">((db, { session }) =>
    readTranscriptSessionByIdentity(db, session),
  ),
  "transcripts.entry": readTranscript<"transcripts.entry">((db, { selector, purpose }) =>
    readTranscriptEntry(db, selector, purpose),
  ),
  "transcripts.latest": readTranscript<"transcripts.latest">(readLatestTranscriptEntry),
  "transcripts.notes": readTranscript<"transcripts.notes">((db, { session }) =>
    readStoredTranscriptNotes(db, session),
  ),
  "transcripts.libraryEntry": readTranscript<"transcripts.libraryEntry">((db, params) =>
    runSqliteReadSnapshotSync(db, () => readTranscriptLibraryEntry(db, params)),
  ),
  "transcripts.recentStopped": readTranscript<"transcripts.recentStopped">(
    (db, { source, stoppedAfter, stoppedBefore }) =>
      readRecentStoppedTranscriptSession(db, source, stoppedAfter, stoppedBefore),
  ),
  "transcripts.summaryRevision": readTranscript<"transcripts.summaryRevision">((db, { session }) =>
    readTranscriptSummaryInputRevision(db, session),
  ),
  "transcripts.utterances": readTranscript<"transcripts.utterances">((db, { session }) =>
    readTranscriptUtterances(db, session),
  ),
  "transcripts.summary": readTranscript<"transcripts.summary">((db, { session }) =>
    readStoredTranscriptSummary(db, session),
  ),
  "transcripts.exportDigest": readTranscript<"transcripts.exportDigest">((db, { session }) =>
    readTranscriptJsonlDigest(db, session),
  ),
};
