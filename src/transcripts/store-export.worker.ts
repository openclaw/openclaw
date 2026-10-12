import type { DatabaseSync } from "node:sqlite";
import type { TranscriptUtterance } from "../../packages/gateway-protocol/src/schema/transcripts.js";
import { executeSqliteQueryTakeFirstSync, iterateSqliteQuerySync } from "../infra/kysely-sync.js";
import { isSqliteCorruptionError } from "../infra/sqlite-error-diagnostics.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import type { WorkerTaskChannel } from "../infra/worker-task-server.js";
import { invalidateOpenClawStateRuntimeIntegrity } from "../state/openclaw-state-db-integrity-admission.js";
import {
  assertStateReadSchema,
  openOpenClawStateReadConnection,
} from "../state/openclaw-state-db-read-connection.js";
import type { OpenClawStateReadRequest } from "../state/openclaw-state-read.types.js";
import type {
  TranscriptExportChunk,
  TranscriptExportCommand,
  TranscriptExportResult,
} from "./store-export-contract.js";
import {
  iterateTranscriptExport,
  TranscriptLibraryError,
  type TranscriptExportRead,
} from "./store-read.js";
import {
  meetingTranscriptSessionQuery,
  meetingTranscriptUtteranceQuery,
  utteranceFromRow,
} from "./store-sqlite.js";

function* iterateArtifact(
  database: DatabaseSync,
  session: Extract<TranscriptExportCommand, { format: "artifact" }>["session"],
): Generator<string, void> {
  const head = executeSqliteQueryTakeFirstSync(
    database,
    meetingTranscriptSessionQuery(database, session).select("next_utterance_seq"),
  )?.next_utterance_seq;
  if (head === undefined) {
    throw new Error(`transcripts session not found: ${session.sessionId}`);
  }
  if (head === 0) {
    return;
  }
  // One cursor retains the fixed head without one SELECT per 64 exported rows.
  for (const row of iterateSqliteQuerySync(
    database,
    meetingTranscriptUtteranceQuery(database, session)
      .selectAll()
      .where("sequence", "<", head)
      .orderBy("sequence", "asc"),
  )) {
    yield `${JSON.stringify(utteranceFromRow(row))}\n`;
  }
}

/** One read-only snapshot spans every bounded chunk and the final notes. */
export async function streamTranscriptExportInWorker(
  input: OpenClawStateReadRequest,
  command: TranscriptExportCommand,
  channel: WorkerTaskChannel,
  onAdmitted: () => void,
): Promise<TranscriptExportResult> {
  const connection = openOpenClawStateReadConnection(
    input.databasePath,
    input.location,
    input.expectedIdentity,
    input.snapshotRoot,
  );
  const { db } = connection.database;
  const errors: unknown[] = [];
  let result: TranscriptExportResult = { ok: true };
  try {
    db.exec("BEGIN"); // sqlite-allow-raw -- This owner pins one streamed read-only snapshot.
    assertStateReadSchema(db, input.databasePath);
    admitSqliteSchema(db);
    onAdmitted();
    const iterator: Generator<string | TranscriptUtterance, TranscriptExportRead | void> =
      command.format === "library"
        ? iterateTranscriptExport(db, command.selector, command.includeNotes)
        : iterateArtifact(db, command.session);
    let chunk: TranscriptExportChunk =
      command.format === "library"
        ? { format: "library", utterances: [] }
        : { format: "artifact", jsonl: "" };
    let bytes = 0;
    let count = 0;
    try {
      for (let step = iterator.next(); ; step = iterator.next()) {
        if (step.done) {
          if (count) {
            (await channel.request(chunk)).consumed();
          }
          result = { ok: true, read: step.value ?? undefined };
          break;
        }
        const value = step.value;
        const size = Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
        if (count && (count === 64 || bytes + size > 1024 * 1024)) {
          (await channel.request(chunk)).consumed();
          chunk =
            command.format === "library"
              ? { format: "library", utterances: [] }
              : { format: "artifact", jsonl: "" };
          bytes = 0;
          count = 0;
        }
        if (chunk.format === "artifact" && typeof value === "string") {
          chunk.jsonl += value;
        } else if (chunk.format === "library" && typeof value !== "string") {
          chunk.utterances.push(value);
        }
        bytes += size;
        count++;
      }
    } finally {
      iterator.return(undefined);
    }
  } catch (error) {
    if (error instanceof TranscriptLibraryError) {
      result = {
        ok: false,
        error: { type: error.type, message: error.message, maxBytes: error.maxBytes },
      };
    } else {
      if (isSqliteCorruptionError(error)) {
        invalidateOpenClawStateRuntimeIntegrity(db);
      }
      errors.push(error);
    }
  }
  try {
    if (db.isTransaction) {
      db.exec("ROLLBACK"); // sqlite-allow-raw -- End the snapshot before releasing its reader.
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    connection.close();
  } catch (error) {
    errors.push(error);
  }
  throwSqliteLifecycleErrors(errors, "Transcript export and reader cleanup failed");
  return result;
}
