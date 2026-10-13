import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { clearAllCliSessions } from "./cli-session-binding.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  assertLifecycleTargetSnapshotUnchanged,
  type SqliteLifecycleTargetSnapshot,
} from "./session-accessor.sqlite-entry-equality.js";
import {
  readSessionEntrySelectionSnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import {
  assertSqliteTranscriptSnapshotUnchanged,
  type SqliteTranscriptSnapshotRow,
} from "./session-accessor.sqlite-read.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { replaceSqliteTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { COMPACTION_RUN_USAGE_CLEAR_PATCH } from "./session-entry-projection.js";

/** The native adapter and worker share the same transcript/entry compare-and-swap. */
export function applyManualCompactInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  input: {
    rows: readonly SqliteTranscriptSnapshotRow[];
    entries: SqliteLifecycleTargetSnapshot;
    events: TranscriptEvent[];
    nowMs?: number;
  },
  projection?: { scheduleProjectionReconcile: false; onProjectionReconcileNeeded: () => void },
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
  replaceSqliteTranscriptEventsInTransaction(database, scope, input.events, projection);
  const next = structuredClone(previous);
  delete next.contextBudgetStatus;
  Object.assign(next, COMPACTION_RUN_USAGE_CLEAR_PATCH);
  delete next.totalTokens;
  delete next.totalTokensFresh;
  delete next.totalTokensVersion;
  clearAllCliSessions(next);
  next.updatedAt = input.nowMs ?? Date.now();
  // Accounting and harness bindings describe the same transcript generation.
  writeSessionEntry(database, scope.sessionKey, next, { previousEntry: previous });
  return {
    previous: new Map([[scope.sessionKey, previous]]),
    current: new Map([[scope.sessionKey, next]]),
  };
}
