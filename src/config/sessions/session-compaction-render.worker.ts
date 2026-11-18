import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import { getMessageFromEntryForCompaction } from "../../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import { renderConversationEntriesWithinBudget } from "../../../packages/agent-core/src/harness/compaction/conversation-serialization.js";
import { serializeConversationEntry } from "../../../packages/agent-core/src/harness/compaction/utils.js";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import { sanitizeCompactionMessages } from "../../agents/compaction-planning.js";
import { prepareSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { assertOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { validateSessionTranscriptContextInDatabase } from "./session-accessor.sqlite-model-context.js";
import { prepareTranscriptEventReadQuery } from "./session-accessor.sqlite-read.js";
import { toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import type { SessionPreparedCompactionInput } from "./session-compaction-prepared.types.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import { SessionTranscriptStorageUnavailableError } from "./session-transcript-projection-error.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { readTranscriptPayload } from "./transcript-payload.js";

/** Render candidate rows in one short snapshot; neither payloads nor a reader survive inference. */
export async function renderPreparedSessionCompaction(
  request: Omit<SessionPreparedCompactionInput, "operation"> & {
    operation: Extract<SessionPreparedCompactionInput["operation"], { kind: "render" }>;
  },
  control: WorkerTaskControl,
) {
  return await control.runNativeSection(() => {
    control.throwIfCancelled();
    const { operation } = request;
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => {
        if (request.expectedIdentity) {
          assertOpenClawAgentDatabaseIdentity(database, request.expectedIdentity);
        }
        assertSessionTranscriptHot(database.db, request.resolvedScope.sessionId);
        validateSessionTranscriptContextInDatabase(
          database,
          request.resolvedScope,
          { version: operation.version, admission: request.admission },
          "prefix",
        );
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
        return renderConversationEntriesWithinBudget(
          operation.entries,
          operation.maxChars,
          (descriptor, variant) => {
            control.throwIfCancelled();
            const row = readRow(descriptor.source);
            if (!row) {
              throw new Error("Compaction source rows are no longer available");
            }
            const entry: unknown = JSON.parse(readTranscriptPayload(row));
            if (!isIndexedSessionEntry(entry)) {
              throw new Error("Prepared summary source no longer contains its message row");
            }
            const message = getMessageFromEntryForCompaction(entry);
            const projected = message && convertToLlm(sanitizeCompactionMessages([message]))[0];
            if (!projected) {
              throw new Error("Prepared summary source no longer contains its projected message");
            }
            return serializeConversationEntry(projected, descriptor, variant);
          },
        );
      },
      toDatabaseOptions(request.resolvedScope),
      { snapshot: true },
    );
    control.throwIfCancelled();
    if (!result.found) {
      throw new SessionTranscriptStorageUnavailableError(result.reason);
    }
    return result.value;
  });
}
