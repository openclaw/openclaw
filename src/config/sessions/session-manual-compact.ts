import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import {
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptManualTrimResult } from "./session-accessor.types.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import type {
  ManualCompactCommitted,
  ManualCompactInput,
} from "./session-manual-compact.worker.js";
import { executeSessionMessageRewriteOperation } from "./session-message-rewrite-domain.js";
import type { PreparedSessionSourceAuthority } from "./session-source-authority.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

/** Keep the admitted physical owner and host authority until the combined write settles. */
export function trimSessionTranscriptInWorker(
  scope: ResolvedTranscriptScope & { path: string },
  input: Pick<ManualCompactInput, "maxLines" | "nowMs" | "entries">,
  authority: {
    databaseIdentity?: string;
    assertCurrent: () => void;
    source?: PreparedSessionSourceAuthority;
  },
): Promise<SessionTranscriptManualTrimResult> {
  const database = { ...toDatabaseOptions(scope), path: scope.path };
  return runSessionEntryWorkerOperation<ManualCompactCommitted, SessionTranscriptManualTrimResult>({
    database,
    databaseIdentity: authority.databaseIdentity,
    agentId: scope.agentId,
    candidateKind: "session-manual-compact",
    assertCurrent: authority.assertCurrent,
    assertCandidate(candidate) {
      if (candidate.refusedSource) {
        authority.source?.checks[candidate.refusedSource.index]?.refuse(
          candidate.refusedSource.facts,
        );
        throw new Error("Manual compaction source authority changed");
      }
    },
    run: (worker, commit) =>
      commit(() =>
        executeSessionMessageRewriteOperation(worker, database.agentId, {
          type: "session.transcript.manualCompact",
          input: {
            ...input,
            scope,
            sources: authority.source?.checks.map(({ predicate }) => predicate) ?? [],
          },
        }),
      ),
    onCommitted(candidate, published, identity) {
      if (published) {
        publishCommittedSessionIdentity(
          scope.agentId,
          identity,
          published.previous,
          published.current,
          published.prepared,
        );
      }
      if (candidate.projectionNeedsReconcile) {
        startSessionTranscriptIndexReconcile({ ...database, preferredSessionId: scope.sessionId });
      }
      return candidate.result;
    },
  });
}
