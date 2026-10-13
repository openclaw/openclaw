import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
  ManualCompactValidation,
} from "./session-manual-compact.worker.js";
import { executeSessionMessageRewriteOperation } from "./session-message-rewrite-domain.js";
import {
  acceptSessionSourceValidation,
  type PreparedSessionSourceAuthority,
  type SessionSourceValidation,
} from "./session-source-authority.js";
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
  const sources = authority.source?.checks.map(({ predicate }) => predicate) ?? [];
  let sourceMatches: ManualCompactValidation["sourceMatches"] = [];
  let sourceValidation: SessionSourceValidation | undefined;
  const assertCurrent = () => {
    authority.assertCurrent();
    if (!sourceValidation) {
      return;
    }
    authority.source?.assertCurrent();
    for (const match of sourceValidation.conversationMatches) {
      const matches = sourceMatches.find(({ index }) => index === match.index)!.matches;
      const accepted = match.acceptedAlternatives ?? match.alternatives;
      for (let alternative = 0; alternative < matches.length - 1; alternative++) {
        Atomics.store(matches, alternative + 1, accepted.includes(alternative) ? 1 : 0);
      }
    }
  };
  return runSessionEntryWorkerOperation<ManualCompactCommitted, SessionTranscriptManualTrimResult>({
    database,
    databaseIdentity: authority.databaseIdentity,
    agentId: scope.agentId,
    candidateKind: "session-manual-compact",
    assertCurrent,
    onTransactionFacts(facts) {
      if (!isRecord(facts) || facts.kind !== "session-manual-compact-validated") {
        return false;
      }
      // SAFETY: The paired kernel supplies the source indices from this transaction.
      const validated = facts as ManualCompactValidation;
      sourceValidation = validated.sourceValidation;
      sourceMatches = validated.sourceMatches;
      if (authority.source) {
        acceptSessionSourceValidation(authority.source, sourceValidation);
      }
      assertCurrent();
      return true;
    },
    run: (worker, commit) =>
      commit(() =>
        executeSessionMessageRewriteOperation(worker, database.agentId, {
          type: "session.transcript.manualCompact",
          input: {
            ...input,
            scope,
            sources,
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
