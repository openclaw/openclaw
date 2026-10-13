import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
import { readSessionEntrySelectionSnapshot } from "./session-accessor.sqlite-entry-store.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptManualTrimResult } from "./session-accessor.types.js";
import {
  prepareSessionColdSourceGuard,
  type SessionColdSourceMatches,
} from "./session-cold-storage-source-guard.worker.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import { selectManualCompactTranscriptLines } from "./session-manual-compact-selection.js";
import { applyManualCompactInTransaction } from "./session-manual-compact.kernel.js";
import type {
  SessionSourcePredicate,
  SessionSourceValidation,
} from "./session-source-authority.js";

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
  projectionNeedsReconcile: boolean;
  publication?: SessionEntryReplacementPublication;
};

export function compactManualTranscript(
  input: ManualCompactInput,
  context: AgentWorkerOperationContext,
) {
  const sourceMatches = input.sources.flatMap((source, index) =>
    source.conversationAlternatives
      ? [
          {
            index,
            matches: new Int32Array(
              new SharedArrayBuffer(
                (source.conversationAlternatives.length + 1) * Int32Array.BYTES_PER_ELEMENT,
              ),
            ),
          },
        ]
      : [],
  );
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
        projectionNeedsReconcile: false,
      };
      if (selected.result.compacted) {
        const identity = applyManualCompactInTransaction(
          current,
          input.scope,
          {
            rows,
            entries,
            events,
            nowMs: input.nowMs,
          },
          {
            scheduleProjectionReconcile: false,
            onProjectionReconcileNeeded: () => {
              candidate.projectionNeedsReconcile = true;
            },
          },
        );
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
          // The target transaction pins same-store predicates; foreign owners can change at a host grant.
          source.assertForeign();
        },
        candidate,
      );
    },
  );
}
