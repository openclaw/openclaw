import {
  asOptionalRecord,
  isRecord,
  readStringField,
} from "@openclaw/normalization-core/record-coerce";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import type {
  SessionCleanupReadInput,
  SessionCleanupReadResult,
} from "./cleanup-service-read.types.js";
import { readSessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.js";
import { listSqliteSessionEntriesFromDatabase } from "./session-accessor.sqlite-entry-list.read.js";
import { readTranscriptSnapshot } from "./session-accessor.sqlite-read.js";
import { readWithCanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import { shouldPreserveMaintenanceEntry } from "./store-maintenance.js";

function isTranscriptMessageRole(role: unknown): boolean {
  return (
    role === "user" ||
    role === "assistant" ||
    role === "tool" ||
    role === "toolResult" ||
    role === "system"
  );
}

function isTranscriptMessageRecord(entry: unknown): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  const record = entry;
  if (record.type === "message") {
    return true;
  }
  if (
    record.type === undefined &&
    isRecord(record.message) &&
    isTranscriptMessageRole(record.message.role)
  ) {
    return true;
  }
  return record.type === undefined && isTranscriptMessageRole(record.role);
}

/** Entries and positive deletion classifications share one admitted read snapshot. */
export function readSessionCleanupSnapshotInDatabase(
  database: Parameters<typeof listSqliteSessionEntriesFromDatabase>[0],
  request: Pick<SessionCleanupReadInput, "env" | "fixMissing" | "continuation">,
): SessionCleanupReadResult {
  const read = () => {
    const entries = listSqliteSessionEntriesFromDatabase(
      database,
      {
        agentId: database.agentId,
        path: database.path,
        env: request.env,
        sessionKey: "",
      },
      {},
    );
    const store = Object.fromEntries(entries.map(({ sessionKey, entry }) => [sessionKey, entry]));
    const missing: SessionCleanupReadResult["missing"] = [];
    if (request.fixMissing) {
      for (const { sessionKey, entry } of entries) {
        // Cleanup cannot release harness ownership or delete a user-shelved archive.
        if (
          (entry.modelSelectionLocked === true || entry.archivedAt !== undefined) &&
          shouldPreserveMaintenanceEntry({ key: sessionKey, entry })
        ) {
          continue;
        }
        const legacySessionFile = readStringField(asOptionalRecord(entry), "sessionFile");
        if (
          parseAgentSessionKey(sessionKey) &&
          (entry.initializationPending === true ||
            (entry.sessionId === sessionKey && !legacySessionFile?.trim()))
        ) {
          continue;
        }
        if (!entry.sessionId) {
          if (!parseAgentSessionKey(sessionKey)) {
            missing.push({
              sessionKey,
              expectedEntry: entry,
              archiveRemovedTranscript: true,
            });
          }
          continue;
        }
        try {
          // Cold, malformed, or unavailable transcripts cannot prove absence.
          const { events } = readTranscriptSnapshot(database, entry.sessionId);
          if (events.some(isTranscriptMessageRecord)) {
            continue;
          }
          missing.push({
            sessionKey,
            expectedEntry: entry,
            archiveRemovedTranscript: true,
            expectedTranscriptSnapshot: readSessionStateDeleteSnapshot(
              database.db,
              entry.sessionId,
            ),
          });
        } catch {
          continue;
        }
      }
    }
    return { kind: "session-cleanup" as const, store, missing };
  };
  return readWithCanonicalSessionReaderContinuation(database, request.continuation, () =>
    request.fixMissing && !database.db.isTransaction
      ? runSqliteDeferredTransactionSync(database.db, read)
      : read(),
  );
}
