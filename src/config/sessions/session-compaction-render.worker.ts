import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import { renderConversationEntriesWithinBudget } from "../../../packages/agent-core/src/harness/compaction/conversation-serialization.js";
import { serializeConversationEntry } from "../../../packages/agent-core/src/harness/compaction/utils.js";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import { sanitizeCompactionMessages } from "../../agents/compaction-planning.js";
import { readPreparedCompactionMessage } from "../../agents/embedded-agent-runner/prepared-compaction-plan.js";
import type { SessionEntry } from "../../agents/sessions/session-manager-types.js";
import {
  iterateSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { assertOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly-open.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { validateSessionTranscriptContextInDatabase } from "./session-accessor.sqlite-model-context.js";
import { prepareTranscriptEventReadQuery } from "./session-accessor.sqlite-read.js";
import { toDatabaseOptions } from "./session-accessor.sqlite-scope-helpers.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import type { SessionPreparedCompactionInput } from "./session-compaction-prepared.types.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import { SessionTranscriptStorageUnavailableError } from "./session-transcript-projection-error.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { readTranscriptPayload } from "./transcript-payload.js";

export type CompactionReadCounts = {
  extractedRows: number;
  extractedBytes: number;
  selectedRows: number;
  selectedBytes: number;
};

/** One admitted short snapshot for extraction or selected rereads; never held across inference. */
export async function withCompactionSourceRows<T>(
  request: SessionPreparedCompactionInput,
  control: WorkerTaskControl,
  consume: (source: {
    database: OpenClawAgentReadOnlyDatabase;
    readEntry: (seq: number) => SessionEntry;
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
        const readRow = prepareSqliteQueryTakeFirstSync<
          number,
          Parameters<typeof readTranscriptPayload>[0]
        >(database.db, (parameter) =>
          source.select(["event_json", "event_zstd", "event_utf8_bytes"]).where(
            "seq",
            "=",
            parameter((seq) => seq),
          ),
        );
        const readEntry = (seq: number): SessionEntry => {
          control.throwIfCancelled();
          const row = readRow(seq);
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
        return consume({
          database,
          reads,
          readEntry,
          readEntriesAfter: (seq) =>
            Array.from(
              iterateSqliteQuerySync(
                database.db,
                source.select("seq").where("seq", ">", seq).orderBy("seq", "asc"),
              ),
              (row) => readEntry(row.seq),
            ),
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
  return await withCompactionSourceRows(request, control, ({ readEntry }) =>
    renderConversationEntriesWithinBudget(
      request.operation.entries,
      request.operation.maxChars,
      (descriptor, variant) => {
        const message = readPreparedCompactionMessage(descriptor.source, readEntry);
        const projected = message && convertToLlm(sanitizeCompactionMessages([message]))[0];
        if (!projected) {
          throw new Error("Prepared summary source no longer contains its projected message");
        }
        return serializeConversationEntry(projected, descriptor, variant);
      },
    ),
  );
}
