import { expectDefined } from "@openclaw/normalization-core";
import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import type { Expression } from "kysely";
import { beginEngineStoreReadSnapshot } from "../../infra/database-engine/adapters.js";
import { engineTextByteSliceSql } from "../../infra/database-engine/text-bytes.js";
import {
  executeSqliteQuerySync,
  prepareSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { sqlitePrimaryResultCode } from "../../infra/sqlite-error-diagnostics.js";
import type { WorkerTaskChannel } from "../../infra/worker-task-server.js";
import { assertOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { classifyOpenClawAgentDatabaseReadError } from "../../state/openclaw-agent-db-read-error.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { prepareTranscriptEventReadQuery } from "./session-accessor.sqlite-read.js";
import { toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { readTranscriptContextStateInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import { sessionHistoryCleanupError } from "./session-history-worker-errors.js";
import { SessionTranscriptStorageUnavailableError } from "./session-transcript-projection-error.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import type {
  SessionHistoryWorkerInput,
  SessionTranscriptHydrationChunk,
  SessionTranscriptHydrationWorkerResult,
} from "./session-transcript-worker.types.js";
import { readTranscriptStorageEncoding, transcriptEventJsonSql } from "./transcript-payload.js";

const SLICE_BYTES = 64 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const CHUNK_FRAMES = 128;

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
      const PAGE_ROWS = isPostgresSqlConnection(database.db) ? 16 : 256;
      const source = prepareTranscriptEventReadQuery(database, request.resolvedScope.sessionId, {
        ...request.target,
        beforeEventSeq: fence?.beforeRawSeq,
      });
      const eventSlice = (offset: number | Expression<number>) =>
        engineTextByteSliceSql(
          database.db,
          transcriptEventJsonSql(database.db),
          offset,
          SLICE_BYTES,
        ).as("data");
      const pageQuery = source
        .select(["seq", eventSlice(1)])
        .orderBy("seq", "asc")
        .limit(PAGE_ROWS);
      const readPage = prepareSqliteQuerySync<number, { seq: number; data: Uint8Array }>(
        database.db,
        (parameter) =>
          pageQuery.where(
            "seq",
            ">",
            parameter((seq) => seq),
          ),
      );
      const readPart = prepareSqliteQueryTakeFirstSync<
        { seq: number; offset: number },
        { data: Uint8Array }
      >(database.db, (parameter) =>
        source.select(eventSlice(parameter((value) => value.offset))).where(
          "seq",
          "=",
          parameter((value) => value.seq),
        ),
      );
      let frames: SessionTranscriptHydrationChunk["frames"] = [];
      let bytes = 0;
      let eventCount = 0;
      const flush = async () => {
        if (frames.length === 0) {
          return;
        }
        const response = await channel.request({
          kind: "transcript-hydration-chunk",
          encoding,
          frames,
        } satisfies SessionTranscriptHydrationChunk);
        response.consumed();
        frames = [];
        bytes = 0;
        control.throwIfCancelled();
      };
      let afterSeq = request.afterSeq;
      for (;;) {
        control.throwIfCancelled();
        const page =
          afterSeq === undefined
            ? executeSqliteQuerySync(database.db, pageQuery).rows
            : readPage(afterSeq).rows;
        for (const row of page) {
          for (let offset = 1; ; offset += SLICE_BYTES) {
            control.throwIfCancelled();
            const data =
              offset === 1
                ? row.data
                : expectDefined(readPart({ seq: row.seq, offset }), "transcript snapshot row").data;
            if (bytes + data.byteLength > CHUNK_BYTES) {
              await flush();
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
        if (page.length < PAGE_ROWS) {
          break;
        }
        afterSeq = expectDefined(page.at(-1), "transcript page").seq;
      }
      await flush();
      control.throwIfCancelled();
      outcome = { value: { kind: "full", version, eventCount } };
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
