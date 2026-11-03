import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import {
  type SqliteLifecycleTargetSnapshot,
  assertLifecycleTargetSnapshotUnchanged,
} from "./session-accessor.sqlite-entry-equality.js";
import {
  readSessionEntrySelectionSnapshot,
  readSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import {
  readTranscriptEventRows,
  assertSqliteTranscriptSnapshotUnchanged,
  type SqliteTranscriptSnapshotRow,
} from "./session-accessor.sqlite-read.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { replaceSqliteTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type { SessionTranscriptManualTrimResult } from "./session-accessor.types.js";
import {
  prepareSessionColdSourceGuard,
  type SessionColdSourceMatches,
} from "./session-cold-storage-source-guard.worker.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import { projectManuallyCompactedSessionEntry } from "./session-manual-compact-entry.js";
import { selectManualCompactTranscriptLines } from "./session-manual-compact-selection.js";
import type {
  SessionSourcePredicate,
  SessionSourceValidation,
} from "./session-source-authority.js";
import { createSessionSourceConversationMatches } from "./session-source-conversation-matches.js";

/** Compare the retained user data before replacing its transcript and accounting together. */
function applyManualCompactInTransaction(
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
    rebuildProjectionSynchronously: true,
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

export type ManualCompactInput = {
  scope: ResolvedTranscriptScope;
  maxLines: number;
  nowMs?: number;
  entries?: SqliteLifecycleTargetSnapshot;
  sources: SessionSourcePredicate[];
};

export type ManualCompactValidation = {
  kind: "session-manual-compact-validated";
  sourceValidation: SessionSourceValidation;
  sourceMatches: SessionColdSourceMatches;
};

export type ManualCompactCommitted = {
  kind: "session-manual-compact";
  result: SessionTranscriptManualTrimResult;
  publication?: SessionEntryReplacementPublication;
};

export function compactManualTranscript(
  input: ManualCompactInput,
  context: AgentWorkerOperationContext,
) {
  const sourceMatches = createSessionSourceConversationMatches(input.sources);
  using source = prepareSessionColdSourceGuard(context.options, input.sources, sourceMatches);
  const database = context.open();
  const rows = readTranscriptEventRows(database, input.scope.sessionId);
  const entries =
    input.entries ?? readSessionEntrySelectionSnapshot(database, input.scope.sessionKey, true);
  // Decode and normalize before acquiring the write transaction; commit compares the original bytes.
  const selected = selectManualCompactTranscriptLines(
    rows.map((row) => row.eventJson),
    input.maxLines,
  );
  const events = selected.result.compacted
    ? selected.lines.map((line): TranscriptEvent => JSON.parse(line))
    : [];
  return context.writeTransaction(
    "session.transcript.manual-compact",
    "Manual compaction",
    (current) => {
      assertSessionTranscriptHot(current.db, input.scope.sessionId);
      context.admit("transaction", {
        kind: "session-manual-compact-validated",
        sourceValidation: source.read(current),
        // The admission port preserves shared cells; serialized command inputs would copy them.
        sourceMatches,
      } satisfies ManualCompactValidation);
      const candidate: ManualCompactCommitted = {
        kind: "session-manual-compact",
        result: selected.result,
      };
      if (selected.result.compacted) {
        const identity = applyManualCompactInTransaction(current, input.scope, {
          rows,
          entries,
          events,
          nowMs: input.nowMs,
        });
        candidate.publication = prepareSessionEntryReplacementPublication(
          {
            ...identity,
            pendingArchiveRecovery: false,
            membershipInvalidatedKeys: [],
            maintenancePlans: [],
          },
          current,
        );
      }
      return transferSessionEntryWorkerCandidate(
        current,
        (stage, publication) => {
          context.admit(stage, publication);
          if (stage === "commit") {
            // The target transaction pins same-store predicates; check foreign owners at commit.
            source.assertForeign();
          }
        },
        candidate,
      );
    },
  );
}
