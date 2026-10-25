import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  assertLifecycleTargetSnapshotUnchanged,
  type SqliteLifecycleTargetSnapshot,
} from "./session-accessor.sqlite-entry-equality.js";
import {
  readSessionEntryRow,
  readSessionEntrySelectionSnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import {
  assertSqliteTranscriptSnapshotUnchanged,
  type SqliteTranscriptSnapshotRow,
} from "./session-accessor.sqlite-read.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { replaceSqliteTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { projectManuallyCompactedSessionEntry } from "./session-manual-compact-entry.js";

/** Compare the retained user data before replacing its transcript and accounting together. */
export function applyManualCompactInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  input: {
    rows: readonly SqliteTranscriptSnapshotRow[];
    entries: SqliteLifecycleTargetSnapshot;
    events: TranscriptEvent[];
    nowMs?: number;
  },
) {
  assertSqliteTranscriptSnapshotUnchanged(database, scope.sessionId, input.rows);
  const current = readSessionEntrySelectionSnapshot(database, scope.sessionKey, true);
  assertLifecycleTargetSnapshotUnchanged(
    input.entries,
    current,
    "session.transcript.manual-compact",
  );
  const previous = current[0]?.entry;
  if (!previous || previous.sessionId !== scope.sessionId) {
    throw new Error(`SQLite session changed before compacting ${scope.sessionId}`);
  }
  replaceSqliteTranscriptEventsInTransaction(database, scope, input.events, {
    scheduleProjectionReconcile: false,
  });
  const next = projectManuallyCompactedSessionEntry(
    previous.priorWorkspace
      ? (readSessionEntryRow(database, scope.sessionKey)?.entry ?? previous)
      : previous,
    input.nowMs,
  );
  // Accounting and harness bindings describe the same transcript generation.
  writeSessionEntry(database, scope.sessionKey, next, { previousEntry: previous });
  return {
    previous: new Map([[scope.sessionKey, previous]]),
    current: new Map([[scope.sessionKey, next]]),
  };
}
