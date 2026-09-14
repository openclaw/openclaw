import type { DatabaseSync } from "node:sqlite";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import {
  readLatestTranscriptEntry,
  readStoredTranscriptNotes,
  readTranscriptEntry,
  readTranscriptLibraryEntry,
  TranscriptLibraryError,
} from "./store-read.js";
import {
  readTranscriptSessionByIdentity,
  readTranscriptSessionEntries,
  readTranscriptSessionMatches,
  readStoredTranscriptSummary,
  readTranscriptUtterances,
} from "./store-sqlite-read.js";
import {
  readRecentStoppedTranscriptSession,
  readTranscriptSummaryInputRevision,
} from "./store-sqlite.js";
import type { TranscriptReadCommand, TranscriptReadOperations } from "./store-worker-contract.js";

/** Expected reader refusals retain their domain type; native failures use the shared codec. */
export function executeTranscriptRead(
  database: DatabaseSync,
  command: TranscriptReadCommand,
): TranscriptReadOperations[keyof TranscriptReadOperations]["output"] {
  try {
    switch (command.type) {
      case "transcripts.sessionEntries":
        return {
          ok: true,
          value: runSqliteDeferredTransactionSync(database, () =>
            readTranscriptSessionEntries(database),
          ),
        };
      case "transcripts.matches":
        return {
          ok: true,
          value: runSqliteDeferredTransactionSync(database, () =>
            readTranscriptSessionMatches(database, command.input.params.value),
          ),
        };
      case "transcripts.session":
        return {
          ok: true,
          value: readTranscriptSessionByIdentity(database, command.input.params.session),
        };
      case "transcripts.entry":
        return {
          ok: true,
          value: readTranscriptEntry(
            database,
            command.input.params.selector,
            command.input.params.purpose,
          ),
        };
      case "transcripts.latest":
        return { ok: true, value: readLatestTranscriptEntry(database) };
      case "transcripts.notes":
        return {
          ok: true,
          value: readStoredTranscriptNotes(
            database,
            command.input.params.session,
            command.input.params.purpose,
          ),
        };
      case "transcripts.libraryEntry":
        return {
          ok: true,
          value: runSqliteDeferredTransactionSync(database, () =>
            readTranscriptLibraryEntry(database, command.input.params),
          ),
        };
      case "transcripts.recentStopped":
        return {
          ok: true,
          value: readRecentStoppedTranscriptSession(
            database,
            command.input.params.source,
            command.input.params.stoppedAfter,
            command.input.params.stoppedBefore,
          ),
        };
      case "transcripts.summaryRevision":
        return {
          ok: true,
          value: readTranscriptSummaryInputRevision(database, command.input.params.session),
        };
      case "transcripts.utterances":
        return {
          ok: true,
          value: readTranscriptUtterances(
            database,
            command.input.params.session,
            command.input.params.maxUtterances,
          ),
        };
      case "transcripts.summary":
        return {
          ok: true,
          value: readStoredTranscriptSummary(database, command.input.params.session),
        };
      default:
        throw new Error("Unknown transcript SQLite command");
    }
  } catch (error) {
    if (!(error instanceof TranscriptLibraryError)) {
      throw error;
    }
    return {
      ok: false,
      error: { type: error.type, message: error.message, maxBytes: error.maxBytes },
    };
  }
}
