import { ok } from "@openclaw/normalization-core/result";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { ensureMeetingTranscriptsSchema } from "./sqlite-schema.js";
import { createPreparedTranscriptDateReader } from "./store-date-preparation.js";
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
import type { TranscriptReadCommand, TranscriptReadOperations } from "./store-worker-contract.js";

/** Expected reader refusals retain their domain type; native failures use the shared codec. */
export function executeTranscriptRead(
  target: { database: OpenClawStateDatabase; path: string },
  command: TranscriptReadCommand,
): TranscriptReadOperations[keyof TranscriptReadOperations]["output"] {
  ensureMeetingTranscriptsSchema({
    ...target,
    env: getSqliteWorkerStateContext().environment,
    readOnly: command.input.readOnly,
  });
  const database = target.database.db;
  try {
    switch (command.type) {
      case "transcripts.canonicalSessionRow":
        return ok(readTranscriptCanonicalSessionRow(database, command.input.params.selector));
      case "transcripts.readEntries":
        return ok(
          queryTranscriptReadEntries(
            database,
            command.input.params,
            createPreparedTranscriptDateReader(),
          ),
        );
      case "transcripts.exportOwnership":
        return ok(readTranscriptExportOwnership(database, command.input.params.session));
      case "transcripts.exportPathCollisions":
        return ok(readTranscriptExportPathCollisions(database, command.input.params.exportKey));
      case "transcripts.exportPathOwners":
        return ok(readTranscriptExportPathOwners(database, command.input.params.exportKey));
      case "transcripts.summarySnapshot":
        return ok(
          runSqliteDeferredTransactionSync(database, () =>
            readTranscriptSummarySnapshot(
              database,
              command.input.params.session,
              command.input.params.maxUtterances,
            ),
          ),
        );
      case "transcripts.sessionEntries":
        return ok(
          runSqliteDeferredTransactionSync(database, () => readTranscriptSessionEntries(database)),
        );
      case "transcripts.matches":
        return ok(
          runSqliteDeferredTransactionSync(database, () =>
            readTranscriptSessionMatches(database, command.input.params.value),
          ),
        );
      case "transcripts.session":
        return ok(readTranscriptSessionByIdentity(database, command.input.params.session));
      case "transcripts.entry":
        return ok(
          readTranscriptEntry(
            database,
            command.input.params.selector,
            command.input.params.purpose,
          ),
        );
      case "transcripts.latest":
        return ok(readLatestTranscriptEntry(database));
      case "transcripts.notes":
        return ok(
          readStoredTranscriptNotes(
            database,
            command.input.params.session,
            command.input.params.purpose,
          ),
        );
      case "transcripts.libraryEntry":
        return ok(
          runSqliteDeferredTransactionSync(database, () =>
            readTranscriptLibraryEntry(database, command.input.params),
          ),
        );
      case "transcripts.recentStopped":
        return ok(
          readRecentStoppedTranscriptSession(
            database,
            command.input.params.source,
            command.input.params.stoppedAfter,
            command.input.params.stoppedBefore,
          ),
        );
      case "transcripts.summaryRevision":
        return ok(readTranscriptSummaryInputRevision(database, command.input.params.session));
      case "transcripts.utterances":
        return ok(
          readTranscriptUtterances(
            database,
            command.input.params.session,
            command.input.params.maxUtterances,
          ),
        );
      case "transcripts.summary":
        return ok(readStoredTranscriptSummary(database, command.input.params.session));
      case "transcripts.exportDigest":
        return ok(readTranscriptJsonlDigest(database, command.input.params.session));
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
