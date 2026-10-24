import { expectDefined } from "@openclaw/normalization-core";
import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import type { Expression } from "kysely";
import { beginEngineStoreReadSnapshot } from "../../infra/database-engine/adapters.js";
import { engineTextByteSliceSql } from "../../infra/database-engine/text-bytes.js";
import {
  executeSqliteQuerySync,
  iterateSqliteQuerySync,
  prepareSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { sqlitePrimaryResultCode } from "../../infra/sqlite-error-diagnostics.js";
import type { WorkerTaskChannel } from "../../infra/worker-task-server.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { assertOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { classifyOpenClawAgentDatabaseReadError } from "../../state/openclaw-agent-db-read-error.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { selectConversationRowsFromDatabase } from "./session-accessor.sqlite-conversation-read.js";
import {
  readSessionEntryRow,
  readSessionKeyBySessionIdInDatabase,
} from "./session-accessor.sqlite-entry-read.js";
import { prepareTranscriptEventReadQuery } from "./session-accessor.sqlite-read.js";
import { toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { readTranscriptContextStateInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import type { SessionCompactionPreparation } from "./session-history-read.types.js";
import { sessionHistoryCleanupError } from "./session-history-worker-errors.js";
import { SessionTranscriptStorageUnavailableError } from "./session-transcript-projection-error.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import type {
  SessionHistoryWorkerInput,
  SessionTranscriptHydrationChunk,
  SessionTranscriptHydrationWorkerResult,
} from "./session-transcript-worker.types.js";
import {
  MAX_COMPRESSED_EVENT_BYTES,
  readTranscriptStorageEncoding,
  transcriptEventJsonSql,
} from "./transcript-payload.js";

const SLICE_BYTES = 64 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const CHUNK_FRAMES = 128;

/** Read the compaction owner's session facts inside the transcript's own read snapshot. */
export function readSessionCompactionPreparation(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db">,
  request: Pick<
    Extract<SessionHistoryWorkerInput, { kind: "transcript-hydration" }>,
    "database" | "resolvedScope" | "target"
  >,
): SessionCompactionPreparation {
  const requestedKey = request.target.sessionKey ?? "";
  const sessionKey =
    readSessionKeyBySessionIdInDatabase(database, request.resolvedScope.sessionId) ?? requestedKey;
  const sessionTarget = {
    agentId: request.resolvedScope.agentId,
    sessionId: request.resolvedScope.sessionId,
    sessionKey,
    storePath: request.database.path,
  };
  const entry = readSessionEntryRow(database, requestedKey)?.entry;
  const runtimeEntry =
    requestedKey === sessionKey ? entry : readSessionEntryRow(database, sessionKey)?.entry;
  const [primaryConversation] = selectConversationRowsFromDatabase(database, {
    primarySession: { sessionId: sessionTarget.sessionId, sessionKey: requestedKey },
  });
  return { sessionTarget, entry, runtimeEntry, primaryConversation };
}

/** One task owns its snapshot through every acknowledged frame and native cleanup. */
export async function streamSessionTranscriptHydration(
  request: Extract<SessionHistoryWorkerInput, { kind: "transcript-hydration" }>,
  channel: WorkerTaskChannel,
  control: WorkerTaskControl,
): Promise<Extract<SessionTranscriptHydrationWorkerResult, { kind: "full" }>> {
  return await control.runNativeSection(async () => {
    const opened = openOpenClawAgentDatabaseReadOnly(toDatabaseOptions(request.resolvedScope));
    if (!opened.found) {
      throw new SessionTranscriptStorageUnavailableError(opened.reason);
    }
    const { database } = opened;
    let snapshot: ReturnType<typeof beginEngineStoreReadSnapshot> | undefined;
    let outcome:
      | { value: Extract<SessionTranscriptHydrationWorkerResult, { kind: "full" }> }
      | { error: unknown };
    try {
      if (request.expectedIdentity) {
        assertOpenClawAgentDatabaseIdentity(database, request.expectedIdentity);
      }
      snapshot = beginEngineStoreReadSnapshot(database.db);
      const fence = resolveSqliteSessionTranscriptReadFence({ database, ...request.resolvedScope });
      const { version, coldArchive } = readTranscriptContextStateInTransaction(
        database,
        request.resolvedScope.sessionId,
      );
      if (coldArchive) {
        throw new SessionTranscriptColdError(request.resolvedScope.sessionId);
      }
      const encoding = readTranscriptStorageEncoding(database.db);
      const source = prepareTranscriptEventReadQuery(database, request.resolvedScope.sessionId, {
        ...request.target,
        beforeEventSeq: fence?.beforeRawSeq,
      });
      const eventSlice = (offset: number | Expression<number>, length = SLICE_BYTES) =>
        engineTextByteSliceSql(database.db, transcriptEventJsonSql(database.db), offset, length);
      const rowQuery = source
        .select((eb) => [
          "seq",
          eb
            .case()
            .when(
              eb.and([
                eb("event_json", "is", null),
                eb("event_utf8_bytes", ">=", encoding === "UTF-8" ? SLICE_BYTES : SLICE_BYTES / 2),
              ]),
            )
            .then(null)
            .else(eventSlice(1))
            .end()
            .as("data"),
        ])
        .orderBy("seq", "asc");
      const readPart = prepareSqliteQueryTakeFirstSync<
        { seq: number; offset: number },
        { data: Uint8Array }
      >(database.db, (parameter) =>
        source.select(eventSlice(parameter((value) => value.offset)).as("data")).where(
          "seq",
          "=",
          parameter((value) => value.seq),
        ),
      );
      // Compressed records are bounded; identity TEXT must retain native slicing for giant imports.
      const readCompressed = prepareSqliteQueryTakeFirstSync<number, { data: Uint8Array }>(
        database.db,
        (parameter) =>
          source.select(eventSlice(1, MAX_COMPRESSED_EVENT_BYTES * 2).as("data")).where(
            "seq",
            "=",
            parameter((seq) => seq),
          ),
      );
      function* readRows() {
        if (!isPostgresSqlConnection(database.db)) {
          control.throwIfCancelled();
          const afterSeq = request.afterSeq;
          yield* iterateSqliteQuerySync(
            database.db,
            afterSeq === undefined ? rowQuery : rowQuery.where("seq", ">", afterSeq),
          );
          return;
        }
        // Budget initial slices before loading payloads; tiny events can share a bridge trip.
        const PAGE_BYTES = 4 * 1024 * 1024;
        const ROW_BYTES = 64;
        const METADATA_ROWS = PAGE_BYTES / ROW_BYTES;
        const initialRows = Math.floor(PAGE_BYTES / (SLICE_BYTES + ROW_BYTES));
        // Short histories stay one trip; this first page fits even if every slice is full.
        const initial = executeSqliteQuerySync(
          database.db,
          (request.afterSeq === undefined
            ? rowQuery
            : rowQuery.where("seq", ">", request.afterSeq)
          ).limit(initialRows),
        ).rows;
        yield* initial;
        if (initial.length < initialRows) {
          return;
        }
        const readMetadata = prepareSqliteQuerySync<number, { seq: number; slice_bytes: number }>(
          database.db,
          (parameter) =>
            source
              .where(
                "seq",
                ">",
                parameter((seq) => seq),
              )
              .select("seq")
              .select((eb) =>
                eb
                  .fn<number>("least", [
                    eb.fn.coalesce(transcriptEventReadBytesSql(), eb.val(SLICE_BYTES)),
                    eb.val(SLICE_BYTES),
                  ])
                  .as("slice_bytes"),
              )
              .orderBy("seq", "asc")
              // Empty events still cost bookkeeping and must not create an unbounded row array.
              .limit(METADATA_ROWS),
        );
        const readPage = prepareSqliteQuerySync<
          { firstSeq: number; lastSeq: number },
          { seq: number; data: Uint8Array | null }
        >(database.db, (parameter) =>
          rowQuery
            .where(
              "seq",
              ">=",
              parameter((page) => page.firstSeq),
            )
            .where(
              "seq",
              "<=",
              parameter((page) => page.lastSeq),
            ),
        );
        let afterSeq = expectDefined(initial.at(-1), "initial transcript page").seq;
        for (;;) {
          control.throwIfCancelled();
          const metadata = readMetadata(afterSeq).rows;
          // Retain this bounded lookahead so large events do not repeatedly scan the same tail.
          for (let start = 0; start < metadata.length;) {
            let end = start + 1;
            let bytes = metadata[start]!.slice_bytes + ROW_BYTES;
            while (
              end < metadata.length &&
              bytes + metadata[end]!.slice_bytes + ROW_BYTES <= PAGE_BYTES
            ) {
              bytes += metadata[end]!.slice_bytes + ROW_BYTES;
              end++;
            }
            control.throwIfCancelled();
            yield* readPage({ firstSeq: metadata[start]!.seq, lastSeq: metadata[end - 1]!.seq })
              .rows;
            start = end;
          }
          if (metadata.length < METADATA_ROWS) {
            return;
          }
          afterSeq = expectDefined(metadata.at(-1), "transcript metadata page").seq;
        }
      }
      let frames: SessionTranscriptHydrationChunk["frames"] = [];
      let transfers: ArrayBuffer[] = [];
      let bytes = 0;
      let eventCount = 0;
      const flush = async () => {
        if (frames.length === 0) {
          return;
        }
        const response = await channel.request(
          {
            kind: "transcript-hydration-chunk",
            encoding,
            frames,
          } satisfies SessionTranscriptHydrationChunk,
          transfers,
        );
        response.consumed();
        frames = [];
        transfers = [];
        bytes = 0;
        control.throwIfCancelled();
      };
      for (const row of readRows()) {
        const initial =
          row.data ??
          expectDefined(readCompressed(row.seq), "compressed transcript snapshot row").data;
        for (let offset = 1; ; offset += SLICE_BYTES) {
          control.throwIfCancelled();
          // A shared subarray would clone the entire event or detach later slices on transfer.
          const owned =
            row.data === null
              ? Uint8Array.from(initial.subarray(offset - 1, offset - 1 + SLICE_BYTES))
              : undefined;
          const data =
            owned ??
            (offset === 1
              ? initial
              : expectDefined(readPart({ seq: row.seq, offset }), "transcript snapshot row").data);
          if (bytes + data.byteLength > CHUNK_BYTES) {
            await flush();
          }
          if (owned) {
            transfers.push(owned.buffer);
          }
          const endOfEvent = data.byteLength < SLICE_BYTES;
          frames.push({
            data,
            endOfEvent,
            ...(request.includeEventJson && endOfEvent ? { seq: row.seq } : {}),
          });
          bytes += data.byteLength;
          if (bytes >= CHUNK_BYTES || frames.length >= CHUNK_FRAMES) {
            await flush();
          }
          if (endOfEvent) {
            eventCount++;
            break;
          }
        }
      }
      await flush();
      control.throwIfCancelled();
      outcome = {
        value: { kind: "full", version, eventCount },
      };
    } catch (error) {
      outcome = {
        error:
          sqlitePrimaryResultCode(error) === 1
            ? classifyOpenClawAgentDatabaseReadError(database.db, error)
            : error,
      };
    }
    try {
      try {
        snapshot?.close();
      } finally {
        database.close();
      }
    } catch (cleanupError) {
      throw "error" in outcome
        ? sessionHistoryCleanupError(outcome.error, cleanupError, "database close")
        : cleanupError;
    }
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.value;
  });
}
