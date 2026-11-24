import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import {
  renderConversationEntriesWithinBudget,
  type ConversationTextVariant,
} from "../../../packages/agent-core/src/harness/compaction/conversation-serialization.js";
import { serializeConversationEntry } from "../../../packages/agent-core/src/harness/compaction/utils.js";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import { sanitizeCompactionMessages } from "../../agents/compaction-planning.js";
import { readPreparedCompactionMessage } from "../../agents/embedded-agent-runner/prepared-compaction-plan.js";
import type { SessionEntry } from "../../agents/sessions/session-manager-types.js";
import {
  executeSqliteQuerySync,
  iterateSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { assertOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly-open.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { chunkItems } from "../../utils/chunk-items.js";
import { validateSessionTranscriptContextInDatabase } from "./session-accessor.sqlite-model-context.js";
import { prepareTranscriptEventReadQuery } from "./session-accessor.sqlite-read.js";
import { toDatabaseOptions } from "./session-accessor.sqlite-scope-helpers.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import type { SessionPreparedCompactionInput } from "./session-compaction-prepared.types.js";
import type { CompactionReadCounts } from "./session-compaction-read-counts.types.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import { SessionTranscriptStorageUnavailableError } from "./session-transcript-projection-error.js";
import { TRANSCRIPT_PAYLOAD_SLICE_BYTES } from "./session-transcript-read-bytes.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { readTranscriptPayload } from "./transcript-payload.js";

const COMPACTION_PAYLOAD_BATCH_ROWS = 128;

/** One admitted short snapshot for extraction or selected rereads; never held across inference. */
export async function withCompactionSourceRows<T>(
  request: SessionPreparedCompactionInput,
  control: WorkerTaskControl,
  consume: (source: {
    database: OpenClawAgentReadOnlyDatabase;
    readEntry: (seq: number) => SessionEntry;
    readEntries: (sequences: Iterable<number>) => Iterable<SessionEntry>;
    readEntriesAfter: (seq: number) => SessionEntry[];
    reads: CompactionReadCounts;
  }) => T,
  version: SessionTranscriptContextVersion | undefined = "version" in request.operation
    ? request.operation.version
    : undefined,
): Promise<{ value: T; reads: CompactionReadCounts }> {
  return await control.runNativeSection(() => {
    control.throwIfCancelled();
    const reads = { extractedRows: 0, extractedBytes: 0, selectedRows: 0, selectedBytes: 0 };
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => {
        if (request.expectedIdentity) {
          assertOpenClawAgentDatabaseIdentity(database, request.expectedIdentity);
        }
        assertSessionTranscriptHot(database.db, request.resolvedScope.sessionId);
        if (version) {
          validateSessionTranscriptContextInDatabase(
            database,
            request.resolvedScope,
            { version, admission: request.admission },
            "prefix",
          );
        }
        const fence = resolveSqliteSessionTranscriptReadFence({
          database,
          ...request.resolvedScope,
        });
        const source = prepareTranscriptEventReadQuery(database, request.resolvedScope.sessionId, {
          ...request.target,
          beforeEventSeq: fence?.beforeRawSeq,
        });
        const payloads = source.select(["event_json", "event_zstd", "event_utf8_bytes"]);
        type Payload = Parameters<typeof readTranscriptPayload>[0];
        const readRow = prepareSqliteQueryTakeFirstSync<number, Payload>(database.db, (parameter) =>
          payloads.where(
            "seq",
            "=",
            parameter((seq) => seq),
          ),
        );
        const decodeEntry = (row: Payload | undefined): SessionEntry => {
          if (!row) {
            throw new Error("Compaction source rows are no longer available");
          }
          const payload = readTranscriptPayload(row);
          reads.selectedRows += 1;
          reads.selectedBytes += Buffer.byteLength(payload, "utf8");
          const entry: unknown = JSON.parse(payload);
          if (!isIndexedSessionEntry(entry)) {
            throw new Error("Prepared compaction source no longer contains its indexed row");
          }
          return entry;
        };
        const readEntry = (seq: number) => {
          control.throwIfCancelled();
          return decodeEntry(readRow(seq));
        };
        function* readEntries(sequences: Iterable<number>): Iterable<SessionEntry> {
          if (!isPostgresSqlConnection(database.db)) {
            for (const seq of sequences) {
              yield readEntry(seq);
            }
            return;
          }
          for (const chunk of chunkItems(Array.from(sequences), COMPACTION_PAYLOAD_BATCH_ROWS)) {
            control.throwIfCancelled();
            // The PostgreSQL bridge buffers each result. Bound it before loading
            // payloads and decode larger rows individually in the same snapshot.
            const { rows } = executeSqliteQuerySync(
              database.db,
              payloads
                .select("seq")
                .where("seq", "in", chunk)
                .where(
                  (eb) => eb.fn<number>("octet_length", ["event_json"]),
                  "<=",
                  TRANSCRIPT_PAYLOAD_SLICE_BYTES / COMPACTION_PAYLOAD_BATCH_ROWS,
                ),
            );
            const bySeq = new Map(rows.map((row) => [row.seq, row]));
            for (const seq of chunk) {
              control.throwIfCancelled();
              const row = bySeq.get(seq);
              yield row ? decodeEntry(row) : readEntry(seq);
            }
          }
        }
        function* readSequencesAfter(seq: number) {
          for (const row of iterateSqliteQuerySync(
            database.db,
            source.select("seq").where("seq", ">", seq).orderBy("seq", "asc"),
          )) {
            yield row.seq;
          }
        }
        return consume({
          database,
          reads,
          readEntry,
          readEntries,
          readEntriesAfter: (seq) => Array.from(readEntries(readSequencesAfter(seq))),
        });
      },
      toDatabaseOptions(request.resolvedScope),
      { snapshot: true },
    );
    control.throwIfCancelled();
    if (!result.found) {
      throw new SessionTranscriptStorageUnavailableError(result.reason);
    }
    return { value: result.value, reads };
  });
}

export async function renderPreparedSessionCompaction(
  request: Omit<SessionPreparedCompactionInput, "operation"> & {
    operation: Extract<SessionPreparedCompactionInput["operation"], { kind: "render" }>;
  },
  control: WorkerTaskControl,
) {
  return await withCompactionSourceRows(
    request,
    control,
    ({ database, readEntry, readEntries }) => {
      type Descriptor = (typeof request.operation.entries)[number];
      const render = (
        descriptor: Descriptor,
        variant: ConversationTextVariant,
        read: typeof readEntry,
      ) => {
        const message = readPreparedCompactionMessage(descriptor.source, read);
        const projected = message && convertToLlm(sanitizeCompactionMessages([message]))[0];
        if (!projected) {
          throw new Error("Prepared summary source no longer contains its projected message");
        }
        return serializeConversationEntry(projected, descriptor, variant);
      };
      return renderConversationEntriesWithinBudget(
        request.operation.entries,
        request.operation.maxChars,
        (descriptor, variant) => render(descriptor, variant, readEntry),
        isPostgresSqlConnection(database.db)
          ? function* (reads) {
              const sequences = reads.map(({ entry: { source } }) =>
                typeof source === "number" ? source : source.seq,
              );
              let index = 0;
              for (const row of readEntries(sequences)) {
                const { entry, variant } = reads[index++]!;
                yield render(entry, variant, () => row);
              }
            }
          : undefined,
      );
    },
  );
}
