import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import { readTranscriptEventAtSeqInTransaction } from "./session-accessor.sqlite-read.js";
import type { ResolvedTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "./session-accessor.sqlite-transcript-anchor.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import type {
  SessionTranscriptCurrentTurnEntryRead,
  SessionTranscriptCurrentTurnEntryRequest,
} from "./session-transcript-worker.types.js";

/** Pair one active entry with the exact hydrated view without traversing transcript history. */
export function readSessionTranscriptCurrentTurnEntry(
  scope: SessionTranscriptRuntimeTarget,
  options: SessionTranscriptCurrentTurnEntryRequest & {
    readOnly?: boolean;
    resolvedScope?: ResolvedTranscriptReadScope;
  },
): SessionTranscriptCurrentTurnEntryRead {
  return withCurrentProjectionSnapshot(
    scope,
    ({ database, resolved }) => {
      const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
      const version = readTranscriptContextVersionInTransaction(database, resolved.sessionId);
      if (
        version.generation !== options.version.generation ||
        version.rawSeq !== options.version.rawSeq ||
        version.updatedAt !== options.version.updatedAt
      ) {
        throw new Error("Persisted user turn changed before replay admission");
      }
      const anchor = readActiveTranscriptEntryAnchorInTransaction({
        database,
        resolved: { ...resolved, sessionKey: resolved.sessionKey ?? scope.sessionKey },
        entryId: options.entryId,
      });
      if (fence && anchor && anchor.rawSeq >= fence.beforeRawSeq) {
        return { kind: "current-turn-entry", version };
      }
      const event =
        options.includeEntry && anchor
          ? readTranscriptEventAtSeqInTransaction(database, resolved.sessionId, anchor.rawSeq)
              ?.event
          : undefined;
      return { kind: "current-turn-entry", version, anchor, event };
    },
    options,
  );
}
