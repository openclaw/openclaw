import type { TranscriptEvents } from "../../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { importSqliteSessionRowsBatch } from "./session-accessor.sqlite-import.js";
import { replaceSessionOwnerInTransaction } from "./session-accessor.sqlite-owner.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  advanceTranscriptMutationAtInTransaction,
  ensureTranscriptGenerationInTransaction,
  ensureTranscriptSessionRoot,
  touchTranscriptMutationInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import { createTranscriptEventInserter } from "./session-accessor.sqlite-transcript-store.js";
import { reconcileSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import type { SessionEntry } from "./types.js";

export async function importSqliteSessionRows(
  params: Parameters<typeof importSqliteSessionRowsBatch>[0][number],
) {
  return (await importSqliteSessionRowsBatch([params]))[0]!;
}

/** Reproduces the byte-only handoff written by older legacy-main migrations. */
export async function seedUnindexedTranscriptForTest(
  params: Pick<SessionAccessScope, "agentId" | "env" | "sessionKey" | "storePath"> & {
    entry: SessionEntry;
    events: readonly TranscriptEvents[];
    transcriptMtimeMs?: number;
  },
): Promise<void> {
  await importSqliteSessionRows(params);
  const resolved = { ...resolveSqliteScope(params), sessionId: params.entry.sessionId };
  runOpenClawAgentWriteTransaction((database) => {
    replaceSessionOwnerInTransaction(database, resolved.sessionKey, params.entry.owner);
    const first = params.events[0];
    if (first) {
      ensureTranscriptSessionRoot(database, resolved, first.created_at, { allowStoredAlias: true });
      ensureTranscriptGenerationInTransaction(database, resolved.sessionId);
    }
    const insertEvent = createTranscriptEventInserter(database, resolved.sessionId);
    for (const row of params.events) {
      insertEvent({ seq: row.seq, eventJson: row.event_json, createdAt: row.created_at });
    }
    reconcileSessionTranscriptIndexInTransaction(database.db, resolved.sessionId);
    if (params.transcriptMtimeMs !== undefined) {
      advanceTranscriptMutationAtInTransaction(
        database,
        resolved.sessionId,
        params.transcriptMtimeMs,
      );
    } else if (first) {
      touchTranscriptMutationInTransaction(database, resolved.sessionId);
    }
  }, toDatabaseOptions(resolved));
}
