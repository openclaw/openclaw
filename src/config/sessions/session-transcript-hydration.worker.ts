import { expectDefined } from "@openclaw/normalization-core";
import { sql } from "kysely";
import {
  iterateSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { sqlitePrimaryResultCode } from "../../infra/sqlite-error-diagnostics.js";
import type { WorkerTaskControl } from "../../infra/worker-task-native-sections.js";
import type { WorkerTaskChannel } from "../../infra/worker-task-server.js";
import { classifyOpenClawAgentDatabaseReadError } from "../../state/openclaw-agent-db-read-error.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { prepareTranscriptEventReadQuery } from "./session-accessor.sqlite-read.js";
import { toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
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
    let outcome:
      | { value: Extract<SessionTranscriptHydrationWorkerResult, { kind: "full" }> }
      | { error: unknown };
    try {
      // sqlite-allow-raw: This task's dedicated read-only handle keeps one snapshot across host ACKs.
      database.db.exec("BEGIN DEFERRED");
      const fence = resolveSqliteSessionTranscriptReadFence({ database, ...request.resolvedScope });
      assertSessionTranscriptHot(database.db, request.resolvedScope.sessionId);
      const version = readTranscriptContextVersionInTransaction(
        database,
        request.resolvedScope.sessionId,
      );
      const encoding = readTranscriptStorageEncoding(database.db);
      const source = prepareTranscriptEventReadQuery(database, request.resolvedScope.sessionId, {
        ...request.target,
        beforeEventSeq: fence?.beforeRawSeq,
      });
      const readPart = prepareSqliteQueryTakeFirstSync<
        { seq: number; offset: number },
        { data: Uint8Array }
      >(database.db, (parameter) =>
        source
          .select(
            /* kysely-allow-raw: Slice database-encoded canonical bytes natively so identity TEXT never enters JS whole. */
            sql<Uint8Array>`substr(CAST(${transcriptEventJsonSql(database.db)} AS BLOB), ${parameter((value) => value.offset)}, ${SLICE_BYTES})`.as(
              "data",
            ),
          )
          .where(
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
      for (const row of iterateSqliteQuerySync(
        database.db,
        source.select("seq").orderBy("seq", "asc"),
      )) {
        for (let offset = 1; ; offset += SLICE_BYTES) {
          control.throwIfCancelled();
          const { data } = expectDefined(
            readPart({ seq: row.seq, offset }),
            "transcript snapshot row",
          );
          if (bytes + data.byteLength > CHUNK_BYTES) {
            await flush();
          }
          const endOfEvent = data.byteLength < SLICE_BYTES;
          frames.push({ data, endOfEvent });
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
        if (database.db.isTransaction) {
          // sqlite-allow-raw: Finish this read snapshot before releasing its native handle.
          database.db.exec("ROLLBACK");
        }
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
